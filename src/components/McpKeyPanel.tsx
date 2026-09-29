import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import {
  CopyOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { supabase } from "../utils/supabase";
import type { SysMcpApiKeysRow } from "../types/database";

const { Text, Paragraph } = Typography;

/**
 * 「我的密钥」面板 —— MCP 服务 API Key 的自助管理。
 *
 * 安全模型的三个要点（改动这个文件前请先读）：
 *
 *   1. 明文只在浏览器内存里活一次。生成后立即算 SHA-256 入库，
 *      发给数据库的只有摘要与展示用前缀，明文既不落库也不上云。
 *      代价：关掉弹窗即永久丢失，只能吊销重发。
 *
 *   2. 归属由数据库决定，不由前端决定。insert 时不传 user_id，
 *      交给列的 DEFAULT current_sys_user_id()；即便传了，
 *      表的 RLS 策略 WITH CHECK 也会拦住「替别人写」。
 *
 *   3. 越权读同样被数据库挡住。查询不写 user_id 过滤条件，
 *      依赖 RLS 的 USING (user_id = current_sys_user_id()) 收敛到本人 —— 
 *      少一处可能写错的前端过滤，就少一处泄露路径。
 *
 * 文案全部走 i18n（mcpKeys.*）。密钥名、前缀、时间等数据本身不翻译；
 * 时间格式按当前界面语言渲染。
 */

type KeyRow = Pick<
  SysMcpApiKeysRow,
  "id" | "name" | "key_prefix" | "expires_at" | "revoked_at" | "last_used_at" | "created_at"
>;

const LIST_COLUMNS = "id, name, key_prefix, expires_at, revoked_at, last_used_at, created_at";

/** 192 位熵，与后端 `openssl rand -hex 24` 保持同等强度与长度 */
const KEY_BYTES = 24;

const EXPIRY_DAYS = [30, 90, 180, 0];

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** 与后端 Node 的 createHash("sha256") 结果必须逐字节一致 */
const sha256Hex = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

const buildClientConfig = (plainKey: string) =>
  JSON.stringify(
    {
      mcpServers: {
        "operp-erp": {
          command: "/abs/path/to/node",
          args: ["/abs/path/ai-server/dist/mcp/server.js"],
          env: { MCP_API_KEY: plainKey },
        },
      },
    },
    null,
    2,
  );

export function McpKeyPanel() {
  const { t, i18n } = useTranslation();

  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<number>(90);
  /** 明文只存在于这个 state，关闭弹窗即销毁 */
  const [createdPlain, setCreatedPlain] = useState<string | null>(null);

  const subtleReady = typeof crypto !== "undefined" && Boolean(crypto.subtle);

  const formatTime = useCallback(
    (value: string | null) =>
      value ? new Date(value).toLocaleString(i18n.language, { hour12: false }) : "—",
    [i18n.language],
  );

  const statusOf = (row: KeyRow) => {
    if (row.revoked_at) return { text: t("mcpKeys.statusRevoked"), color: "red" as const };
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return { text: t("mcpKeys.statusExpired"), color: "orange" as const };
    }
    return { text: t("mcpKeys.statusActive"), color: "green" as const };
  };

  const copyText = async (text: string, tip: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(tip);
    } catch {
      message.error(t("mcpKeys.msgCopyFailed"));
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    // 故意不写 .eq("user_id", ...)：隔离交给 RLS，前端过滤只是可被绕过的第二道锁
    const { data, error } = await supabase
      .from("sys_mcp_api_keys")
      .select(LIST_COLUMNS)
      .eq("is_deleted", "n")
      .order("created_at", { ascending: false });

    if (error) {
      message.error(t("mcpKeys.msgLoadFailed", { message: error.message }));
    } else {
      setRows((data ?? []) as KeyRow[]);
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openModal = () => {
    setKeyName(t("mcpKeys.defaultName"));
    setExpiresInDays(90);
    setCreatedPlain(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    const hadNewKey = Boolean(createdPlain);
    setModalOpen(false);
    setCreatedPlain(null);
    if (hadNewKey) void load();
  };

  const handleGenerate = async () => {
    if (!subtleReady) {
      message.error(t("mcpKeys.noCryptTitle"));
      return;
    }

    setGenerating(true);
    try {
      const plain = `operp_${randomHex(KEY_BYTES)}`;
      const keyHash = await sha256Hex(plain);
      // 存前 14 位（operp_ + 8 位 hex）作为展示前缀，不含足够信息反推明文
      const keyPrefix = plain.slice(0, 14);
      const expiresAt =
        expiresInDays > 0
          ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
          : null;

      const { error } = await supabase.from("sys_mcp_api_keys").insert({
        name: keyName.trim() || t("mcpKeys.unnamed"),
        key_prefix: keyPrefix,
        key_hash: keyHash,
        expires_at: expiresAt,
      });

      if (error) throw error;

      setCreatedPlain(plain);
      message.success(t("mcpKeys.msgGenerated"));
    } catch (error) {
      message.error(
        t("mcpKeys.msgGenerateFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (row: KeyRow) => {
    const { error } = await supabase
      .from("sys_mcp_api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", row.id);

    if (error) {
      message.error(t("mcpKeys.msgRevokeFailed", { message: error.message }));
      return;
    }
    message.success(t("mcpKeys.msgRevoked", { name: row.name }));
    void load();
  };

  const expiryOptions = EXPIRY_DAYS.map((days) => ({
    value: days,
    label:
      days === 0
        ? t("mcpKeys.expiryNever")
        : t(`mcpKeys.expiry${days}` as "mcpKeys.expiry30"),
  }));

  const columns: ColumnsType<KeyRow> = [
    { title: t("mcpKeys.colName"), dataIndex: "name", width: 160, ellipsis: true },
    {
      title: t("mcpKeys.colPrefix"),
      dataIndex: "key_prefix",
      width: 170,
      render: (value: string) => <Text code>{value}…</Text>,
    },
    {
      title: t("mcpKeys.colStatus"),
      key: "status",
      width: 80,
      render: (_, row) => {
        const { text, color } = statusOf(row);
        return <Tag color={color}>{text}</Tag>;
      },
    },
    {
      title: t("mcpKeys.colLastUsed"),
      dataIndex: "last_used_at",
      width: 160,
      render: (value: string | null) =>
        value ? formatTime(value) : <Text type="secondary">{t("mcpKeys.neverUsed")}</Text>,
    },
    {
      title: t("mcpKeys.colCreatedAt"),
      dataIndex: "created_at",
      width: 160,
      render: (value: string | null) => formatTime(value),
    },
    {
      title: t("mcpKeys.colAction"),
      key: "action",
      width: 100,
      render: (_, row) => {
        const revoked = Boolean(row.revoked_at);
        return revoked ? (
          <Text type="secondary">—</Text>
        ) : (
          <Popconfirm
            title={t("mcpKeys.revokeConfirmTitle")}
            description={t("mcpKeys.revokeConfirmDesc")}
            okText={t("mcpKeys.revokeOk")}
            okButtonProps={{ danger: true }}
            cancelText={t("mcpKeys.cancel")}
            onConfirm={() => handleRevoke(row)}
          >
            <Button type="link" danger size="small" icon={<DeleteOutlined />}></Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Alert
        type="warning"
        showIcon
        icon={<WarningOutlined />}
        message={t("mcpKeys.plainOnceTitle")}
        description={t("mcpKeys.plainOnceDesc")}
      />

      {!subtleReady && (
        <Alert
          type="error"
          showIcon
          message={t("mcpKeys.noCryptTitle")}
          description={t("mcpKeys.noCryptDesc")}
        />
      )}

      <Space>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={openModal}
          disabled={!subtleReady}
        >
          {t("mcpKeys.generate")}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
          {t("mcpKeys.refresh")}
        </Button>
      </Space>

      <Table<KeyRow>
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: t("mcpKeys.empty") }}
      />

      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        {t("mcpKeys.footnoteBefore")}
        <Text strong>{t("mcpKeys.footnoteAccount")}</Text>
        {t("mcpKeys.footnoteAfter")}
      </Paragraph>

      <Modal
        title={createdPlain ? t("mcpKeys.modalTitleCreated") : t("mcpKeys.modalTitleNew")}
        open={modalOpen}
        onCancel={closeModal}
        footer={
          createdPlain
            ? [
                <Button key="close" type="primary" onClick={closeModal}>
                  {t("mcpKeys.savedClose")}
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={closeModal}>
                  {t("mcpKeys.cancel")}
                </Button>,
                <Button
                  key="ok"
                  type="primary"
                  loading={generating}
                  onClick={() => void handleGenerate()}
                >
                  {t("mcpKeys.generateBtn")}
                </Button>,
              ]
        }
        width={420}
      >
        {createdPlain ? (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Alert
              type="success"
              showIcon
              message={t("mcpKeys.createdAlertTitle")}
              description={t("mcpKeys.createdAlertDesc")}
            />
            <Input.TextArea
              value={createdPlain}
              readOnly
              autoSize={{ minRows: 2, maxRows: 3 }}
              style={{ fontFamily: "monospace" }}
            />
            <Space>
              <Button
                type="primary"
                icon={<CopyOutlined />}
                onClick={() => void copyText(createdPlain, t("mcpKeys.msgKeyCopied"))}
              >
                {t("mcpKeys.copyKey")}
              </Button>
              <Button
                icon={<CopyOutlined />}
                onClick={() =>
                  void copyText(buildClientConfig(createdPlain), t("mcpKeys.msgConfigCopied"))
                }
              >
                {t("mcpKeys.copyConfig")}
              </Button>
            </Space>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t("mcpKeys.configTemplate")}
              </Text>
              <pre
                style={{
                  background: "var(--color-background-tertiary, #f5f5f5)",
                  padding: 12,
                  borderRadius: 8,
                  fontSize: 12,
                  marginTop: 8,
                  marginBottom: 0,
                  overflowX: "auto",
                }}
              >
                {buildClientConfig(createdPlain)}
              </pre>
            </div>
          </Space>
        ) : (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <div>
              <Text>{t("mcpKeys.nameLabel")}</Text>
              <Input
                value={keyName}
                onChange={(event) => setKeyName(event.target.value)}
                placeholder={t("mcpKeys.namePlaceholder")}
                maxLength={100}
                style={{ marginTop: 4 }}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t("mcpKeys.nameHint")}
              </Text>
            </div>
            <div>
              <Text>{t("mcpKeys.expiryLabel")}</Text>
              <Select
                value={expiresInDays}
                onChange={setExpiresInDays}
                options={expiryOptions}
                style={{ width: "100%", marginTop: 4 }}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t("mcpKeys.expiryHint")}
              </Text>
            </div>
          </Space>
        )}
      </Modal>
    </Space>
  );
}
