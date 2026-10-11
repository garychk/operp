import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  Checkbox,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile, UploadProps } from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ImportOutlined,
  SyncOutlined,
  InboxOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import { useAuth } from "../../contexts/AuthContext";

const resolveAIBaseUrl = () => {
  const explicitUrl = import.meta.env.VITE_AI_SERVER_URL;
  if (explicitUrl) {
    return explicitUrl.replace(/\/$/, "");
  }
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return "http://localhost:3001/api/ai";
  }
  return "/api/ai";
};

const AI_SERVER_URL = resolveAIBaseUrl();

/**
 * 文件上传白名单 —— 必须与后端两处保持一致，改一处就得改三处：
 *   ai-server/src/services/knowledgeImport.ts 的 SUPPORTED_UPLOAD_EXTS
 *   ai-server/src/api/ai.routes.ts 的 MAX_UPLOAD_* 限制
 * 这里只做前端预校验（省一次无用的往返），真正的把关仍在服务端。
 */
const UPLOAD_ALLOWED_EXTS = ["txt", "text", "md", "markdown", "log", "csv", "docx", "pdf"];
const UPLOAD_ACCEPT = UPLOAD_ALLOWED_EXTS.map((ext) => `.${ext}`).join(",");
const MAX_UPLOAD_FILE_SIZE_MB = 20;
const MAX_UPLOAD_FILES = 20;

type KnowledgeDoc = {
  id: number;
  category: string | null;
  title: string;
  content: string;
  tags: string[] | null;
  source_type: string | null;
  source_ref: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type KnowledgeDocFormValues = {
  category?: string;
  title?: string;
  content?: string;
  tagsText?: string;
  source_type?: string;
  source_ref?: string;
  is_active?: boolean;
};

type ImportItem = {
  title: string;
  content: string;
  category?: string;
  tags?: string[];
  source_type?: string;
  source_ref?: string;
  is_active?: boolean;
};

/** POST /api/ai/knowledge/parse 单条返回（与 ai-server knowledgeImport.ts 的 ParsedKnowledgeFile 对齐） */
type ParsedFilePayload = {
  name: string;
  ext: string;
  ok: boolean;
  title: string;
  content: string;
  chars: number;
  truncated: boolean;
  error?: string;
};

type ParseResponse = {
  ok: boolean;
  total?: number;
  succeeded?: number;
  failed?: number;
  files?: ParsedFilePayload[];
  error?: string;
};

/** 解析结果在预览表里的可编辑形态 */
type UploadPreviewItem = {
  /** 稳定 key：同名文件可能出现多次，不能只用 name */
  key: string;
  name: string;
  title: string;
  category: string;
  tagsText: string;
  content: string;
  chars: number;
  truncated: boolean;
  ok: boolean;
  error?: string;
  selected: boolean;
};

function normalizeTags(value?: string | null) {
  return (value || "")
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function KnowledgeBase() {
  const { t } = useTranslation();
  const defaultImportText = t('knowledgeBase.importExample');
  const { user } = useAuth();

  const [rows, setRows] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
  const [importText, setImportText] = useState(defaultImportText);
  const [importing, setImporting] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [form] = Form.useForm<KnowledgeDocFormValues>();

  // —— 文件上传页签 ——
  /** 已选待解析的文件（beforeUpload 返回 false，只暂存不自动上传） */
  const [stagedFiles, setStagedFiles] = useState<UploadFile[]>([]);
  const [previewItems, setPreviewItems] = useState<UploadPreviewItem[]>([]);
  const [parsing, setParsing] = useState(false);
  const [importingFiles, setImportingFiles] = useState(false);
  const [contentPreview, setContentPreview] = useState<{ title: string; content: string } | null>(null);

  const fetchRows = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("sys_ai_knowledge_docs")
        .select("id, category, title, content, tags, source_type, source_ref, is_active, created_at, updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      setRows((data || []) as KnowledgeDoc[]);
    } catch (error) {
      console.error(error);
      message.error(t('knowledgeBase.fetchDocsFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchRows();
  }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true });
    setDrawerOpen(true);
  };

  const openEdit = (record: KnowledgeDoc) => {
    setEditing(record);
    form.setFieldsValue({
      category: record.category || undefined,
      title: record.title,
      content: record.content,
      tagsText: (record.tags || []).join(", "),
      source_type: record.source_type || undefined,
      source_ref: record.source_ref || undefined,
      is_active: record.is_active,
    });
    setDrawerOpen(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await logWithTiming(t('knowledgeBase.logDelete'), "DELETE", async () => {
        const { error } = await supabase
          .from("sys_ai_knowledge_docs")
          .delete()
          .eq("id", id);
        if (error) throw error;
      });
      message.success(t('common.deleteSuccess'));
      await fetchRows();
    } catch (error) {
      console.error(error);
      message.error(t('common.deleteFailed'));
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        category: values.category?.trim() || null,
        title: values.title?.trim() || "",
        content: values.content?.trim() || "",
        tags: normalizeTags(values.tagsText || ""),
        source_type: values.source_type?.trim() || null,
        source_ref: values.source_ref?.trim() || null,
        is_active: values.is_active ?? true,
        updated_at: new Date().toISOString(),
      };

      if (!payload.title || !payload.content) {
        message.warning(t('knowledgeBase.titleContentRequired'));
        return;
      }

      if (editing) {
        await logWithTiming(t('knowledgeBase.logUpdate'), "UPDATE", async () => {
          const { error } = await supabase
            .from("sys_ai_knowledge_docs")
            .update(payload)
            .eq("id", editing.id);
          if (error) throw error;
        });
      } else {
        await logWithTiming(t('knowledgeBase.logCreate'), "INSERT", async () => {
          const { error } = await supabase.from("sys_ai_knowledge_docs").insert({
            ...payload,
            created_at: new Date().toISOString(),
          });
          if (error) throw error;
        });
      }

      setDrawerOpen(false);
      message.success(editing ? t('common.updateSuccess') : t('knowledgeBase.createSuccess'));
      await fetchRows();
    } catch (error) {
      console.error(error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const parsed = JSON.parse(importText) as ImportItem[];
      if (!Array.isArray(parsed) || !parsed.length) {
        message.warning(t('knowledgeBase.importNeedDoc'));
        return;
      }

      const payload = parsed
        .filter((item) => item.title && item.content)
        .map((item) => ({
          category: item.category || null,
          title: item.title.trim(),
          content: item.content.trim(),
          tags: item.tags || [],
          source_type: item.source_type || "import",
          source_ref: item.source_ref || null,
          is_active: item.is_active ?? true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }));

      if (!payload.length) {
        message.warning(t('knowledgeBase.importNoValid'));
        return;
      }

      const { error } = await supabase.from("sys_ai_knowledge_docs").insert(payload);
      if (error) throw error;

      message.success(t('knowledgeBase.importCount', { count: payload.length }));
      await fetchRows();
    } catch (error) {
      console.error(error);
      message.error(t('knowledgeBase.importFailedCheckJson'));
    } finally {
      setImporting(false);
    }
  };

  /** ai-server 所有端点都要 JWT：租户、身份一律以 Authorization 头解析为准 */
  const buildAuthHeader = async (): Promise<Record<string, string>> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
  };

  /**
   * 重建索引。不传 target = 整租户全量重算（慢且贵）；
   * 传 id 或 id 数组 = 只索引这几篇（导入文件后走这条）。
   */
  const handleReindex = async (target?: number | number[]) => {
    // ai-server 走 service_role，绕过 RLS，必须显式告诉它索引哪个租户的文档；
    // 不带 tenant_id 时它只会扫 tenant_id IS NULL 的平台基线行，结果恒为 total=0。
    if (!user?.tenantId) {
      message.warning(t('knowledgeBase.reindexNoTenant'));
      return;
    }
    setReindexing(true);
    try {
      const ids = (Array.isArray(target) ? target : [target])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
      // ai-server 已启用 JWT 鉴权：租户以 Authorization 头解析为准
      const authHeader = await buildAuthHeader();
      const response = await fetch(`${AI_SERVER_URL}/knowledge/reindex`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify({
          ...(ids.length === 1
            ? { doc_id: ids[0] }
            : ids.length > 1
              ? { doc_ids: ids }
              : {}),
          tenant_id: user.tenantId,
        }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        total?: number;
        success?: number;
        failed?: number;
        error?: string;
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || t('knowledgeBase.reindexRequestFailed', { status: response.status }));
      }
      message.success(
        t('knowledgeBase.reindexDone', {
          total: result.total || 0,
          success: result.success || 0,
          failed: result.failed || 0,
        }),
      );
    } catch (error) {
      console.error(error);
      message.error(error instanceof Error ? error.message : t('knowledgeBase.reindexFailed'));
    } finally {
      setReindexing(false);
    }
  };

  const handleReindexHint = t('knowledgeBase.reindexHint');

  // ————————————————— 文件上传页签 —————————————————

  /** 只做前端预校验（省一次无用的往返）。返回 false = 不自动上传，先暂存等用户点「解析文件」 */
  const beforeUploadFile: UploadProps['beforeUpload'] = (file) => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!UPLOAD_ALLOWED_EXTS.includes(ext)) {
      message.error(
        ext === 'doc'
          ? t('knowledgeBase.uploadDocHint')
          : t('knowledgeBase.uploadUnsupported', { ext: ext || '-' }),
      );
      return Upload.LIST_IGNORE;
    }
    if (file.size > MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024) {
      message.error(t('knowledgeBase.uploadTooLarge', { size: MAX_UPLOAD_FILE_SIZE_MB }));
      return Upload.LIST_IGNORE;
    }
    return false;
  };

  const handleStagedChange: UploadProps['onChange'] = ({ fileList }) => {
    if (fileList.length > MAX_UPLOAD_FILES) {
      message.warning(t('knowledgeBase.uploadDraggerHint', {
        size: MAX_UPLOAD_FILE_SIZE_MB,
        count: MAX_UPLOAD_FILES,
      }));
    }
    setStagedFiles(fileList.slice(0, MAX_UPLOAD_FILES));
  };

  const updatePreviewItem = (key: string, patch: Partial<UploadPreviewItem>) => {
    setPreviewItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const handleParseFiles = async () => {
    const files = stagedFiles.filter((item) => item.originFileObj);
    if (!files.length) {
      message.warning(t('knowledgeBase.uploadNeedFile'));
      return;
    }
    setParsing(true);
    try {
      const formData = new FormData();
      for (const item of files) {
        formData.append('files', item.originFileObj as File, item.name);
      }
      const authHeader = await buildAuthHeader();
      const response = await fetch(`${AI_SERVER_URL}/knowledge/parse`, {
        method: 'POST',
        // ⚠️ 不要手动设 Content-Type：multipart 的 boundary 必须由浏览器生成
        headers: authHeader,
        body: formData,
      });
      const result = (await response.json()) as ParseResponse;
      if (!response.ok || !result.ok) {
        throw new Error(result.error || t('knowledgeBase.uploadParseFailed'));
      }

      // 追加而不是覆盖：分几批解析时前面的结果不能被后一批冲掉。
      // key 带上时间戳，避免同一批次同名文件（或跨批次同名）撞 key。
      const stamp = Date.now();
      const parsedItems: UploadPreviewItem[] = (result.files || []).map((file, index) => ({
        key: `${stamp}-${index}-${file.name}`,
        name: file.name,
        title: file.title,
        category: '',
        tagsText: '',
        content: file.content,
        chars: file.chars,
        truncated: file.truncated,
        ok: file.ok,
        error: file.error,
        selected: file.ok,
      }));
      setPreviewItems((prev) => [...prev, ...parsedItems]);
      setStagedFiles([]);

      const summary = {
        succeeded: result.succeeded || 0,
        failed: result.failed || 0,
      };
      if (summary.failed) message.warning(t('knowledgeBase.uploadParseResult', summary));
      else message.success(t('knowledgeBase.uploadParseResult', summary));
    } catch (error) {
      console.error(error);
      message.error(error instanceof Error ? error.message : t('knowledgeBase.uploadParseFailed'));
    } finally {
      setParsing(false);
    }
  };

  const handleImportParsed = async () => {
    const selected = previewItems.filter((item) => item.ok && item.selected);
    if (!selected.length) {
      message.warning(t('knowledgeBase.uploadNoSelection'));
      return;
    }
    setImportingFiles(true);
    try {
      const now = new Date().toISOString();
      const payload = selected.map((item) => ({
        category: item.category.trim() || null,
        title: item.title.trim() || item.name,
        content: item.content,
        tags: normalizeTags(item.tagsText),
        source_type: 'upload',
        // 原文文件本身不入库，这里只留文件名，便于日后回溯来源
        source_ref: item.name,
        is_active: true,
        created_at: now,
        updated_at: now,
      }));

      // 入库走前端直连 PostgREST：RLS + tenant_id 默认值保证只落当前租户。
      // 绝不能让 ai-server 用 service_role 代写 —— 那会绕开 RLS 越权写库。
      const inserted = await logWithTiming(t('knowledgeBase.logUpload'), 'INSERT', async () => {
        const { data, error } = await supabase
          .from('sys_ai_knowledge_docs')
          .insert(payload)
          .select('id');
        if (error) throw error;
        return (data || []) as { id: number }[];
      });

      message.success(t('knowledgeBase.uploadImported', { count: payload.length }));
      setPreviewItems([]);
      await fetchRows();

      // 只索引刚导入的这几篇；不传 id 会把整个租户重算一遍（慢且烧 embedding 额度）
      const newIds = inserted.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));
      if (newIds.length) await handleReindex(newIds);
    } catch (error) {
      console.error(error);
      message.error(t('common.saveFailed'));
    } finally {
      setImportingFiles(false);
    }
  };

  const importableItems = previewItems.filter((item) => item.ok);
  const selectedCount = importableItems.filter((item) => item.selected).length;

  const previewColumns: ColumnsType<UploadPreviewItem> = [
    {
      title: '',
      key: 'selected',
      width: 48,
      render: (_, record) => (
        <Checkbox
          checked={record.selected}
          disabled={!record.ok}
          onChange={(event) => updatePreviewItem(record.key, { selected: event.target.checked })}
        />
      ),
    },
    {
      title: t('knowledgeBase.uploadFile'),
      dataIndex: 'name',
      key: 'name',
      width: 220,
      ellipsis: true,
      render: (value: string, record) => (
        <Tooltip title={record.error || value}>
          <Space size={4}>
            <FileTextOutlined />
            <span>{value}</span>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: t('knowledgeBase.title'),
      key: 'title',
      width: 200,
      render: (_, record) => (
        <Input
          value={record.title}
          disabled={!record.ok}
          onChange={(event) => updatePreviewItem(record.key, { title: event.target.value })}
        />
      ),
    },
    {
      title: t('knowledgeBase.category'),
      key: 'category',
      width: 150,
      render: (_, record) => (
        <Input
          value={record.category}
          disabled={!record.ok}
          placeholder={t('knowledgeBase.categoryPlaceholder')}
          onChange={(event) => updatePreviewItem(record.key, { category: event.target.value })}
        />
      ),
    },
    {
      title: t('knowledgeBase.tags'),
      key: 'tagsText',
      width: 180,
      render: (_, record) => (
        <Input
          value={record.tagsText}
          disabled={!record.ok}
          placeholder={t('knowledgeBase.tagsPlaceholder')}
          onChange={(event) => updatePreviewItem(record.key, { tagsText: event.target.value })}
        />
      ),
    },
    {
      title: t('knowledgeBase.uploadChars'),
      dataIndex: 'chars',
      key: 'chars',
      width: 130,
      render: (value: number, record) =>
        record.truncated ? (
          <Tooltip title={t('knowledgeBase.uploadTruncatedTip', { chars: value })}>
            <Tag color="orange">{value}+</Tag>
          </Tooltip>
        ) : (
          value
        ),
    },
    {
      title: t('common.status'),
      key: 'ok',
      width: 120,
      render: (_, record) =>
        record.ok ? (
          <Tag color="green">{t('knowledgeBase.uploadStatusOk')}</Tag>
        ) : (
          <Tooltip title={record.error}>
            <Tag color="red">{t('knowledgeBase.uploadStatusFailed')}</Tag>
          </Tooltip>
        ),
    },
    {
      title: t('common.actions'),
      key: 'action',
      width: 110,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Tooltip title={t('knowledgeBase.uploadContentPreview')}>
            <Button
              type="text"
              icon={<FileTextOutlined />}
              disabled={!record.ok}
              onClick={() => setContentPreview({ title: record.title || record.name, content: record.content })}
            />
          </Tooltip>
          <Tooltip title={t('knowledgeBase.uploadRemove')}>
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => setPreviewItems((prev) => prev.filter((item) => item.key !== record.key))}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  const columns: ColumnsType<KnowledgeDoc> = [
    { title: t('knowledgeBase.title'), dataIndex: "title", key: "title", ellipsis: true },
    { title: t('knowledgeBase.category'), dataIndex: "category", key: "category", width: 120, render: (value) => value || "-" },
    {
      title: t('knowledgeBase.tags'),
      dataIndex: "tags",
      key: "tags",
      width: 220,
      render: (value: string[] | null) =>
        value?.length ? (
          <Space size={[4, 4]} wrap>
            {value.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </Space>
        ) : (
          "-"
        ),
    },
    { title: t('knowledgeBase.sourceType'), dataIndex: "source_type", key: "source_type", width: 120, render: (value) => value || "-" },
    {
      title: t('knowledgeBase.sourceLink'),
      dataIndex: "source_ref",
      key: "source_ref",
      width: 180,
      ellipsis: true,
      render: (value) => value || "-",
    },
    {
      title: t('common.status'),
      dataIndex: "is_active",
      key: "is_active",
      width: 100,
      render: (value: boolean) => <Tag color={value ? "green" : "default"}>{value ? t('common.enabled') : t('knowledgeBase.inactive')}</Tag>,
    },
    {
      title: t('knowledgeBase.updatedAt'),
      dataIndex: "updated_at",
      key: "updated_at",
      width: 180,
      render: (value) => (value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-"),
    },
    {
      title: t('common.actions'),
      key: "action",
      width: 220,
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button type="text" icon={<SyncOutlined />} onClick={() => void handleReindex(record.id)}>
            {t('knowledgeBase.reindexRow')}
          </Button>
          <Button type="text" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          <Popconfirm title={t('knowledgeBase.confirmDeleteDoc')} onConfirm={() => void handleDelete(record.id)}>
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('knowledgeBase.pageTitle')}
      extra={
        <Space>
          <Button icon={<SyncOutlined />} onClick={() => void fetchRows()}>
            {t('common.refresh')}
          </Button>
          <Button loading={reindexing} icon={<SyncOutlined />} onClick={() => void handleReindex()}>
            {t('knowledgeBase.reindexAll')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('knowledgeBase.newDoc')}
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        {handleReindexHint}
      </Typography.Paragraph>

      <Tabs
        items={[
          {
            key: "manage",
            label: t('knowledgeBase.tabDocuments'),
            children: (
              <Table
                rowKey="id"
                loading={loading}
                columns={columns}
                dataSource={rows}
                scroll={{ x: 1200 }}
              />
            ),
          },
          {
            key: "import",
            label: t('knowledgeBase.tabImport'),
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size="large">
                <Card size="small" title={t('knowledgeBase.importGuide')}>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    {t('knowledgeBase.importInstructions')}
                  </Typography.Paragraph>
                </Card>
                <Input.TextArea
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  autoSize={{ minRows: 12, maxRows: 24 }}
                  placeholder={defaultImportText}
                />
                <Space>
                  <Button type="primary" icon={<ImportOutlined />} loading={importing} onClick={() => void handleImport()}>
                    {t('knowledgeBase.importBtn')}
                  </Button>
                  <Button onClick={() => setImportText(defaultImportText)}>{t('knowledgeBase.restoreExample')}</Button>
                </Space>
              </Space>
            ),
          },
          {
            key: "upload",
            label: t('knowledgeBase.tabUpload'),
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size="large">
                <Card size="small" title={t('knowledgeBase.uploadGuide')}>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    {t('knowledgeBase.uploadInstructions')}
                  </Typography.Paragraph>
                </Card>

                <Upload.Dragger
                  name="files"
                  multiple
                  accept={UPLOAD_ACCEPT}
                  fileList={stagedFiles}
                  beforeUpload={beforeUploadFile}
                  onChange={handleStagedChange}
                >
                  <p className="ant-upload-drag-icon">
                    <InboxOutlined />
                  </p>
                  <p className="ant-upload-text">{t('knowledgeBase.uploadDraggerText')}</p>
                  <p className="ant-upload-hint">
                    {t('knowledgeBase.uploadDraggerHint', {
                      size: MAX_UPLOAD_FILE_SIZE_MB,
                      count: MAX_UPLOAD_FILES,
                    })}
                  </p>
                </Upload.Dragger>

                <Space>
                  <Button
                    type="primary"
                    icon={<ImportOutlined />}
                    loading={parsing}
                    disabled={!stagedFiles.length}
                    onClick={() => void handleParseFiles()}
                  >
                    {parsing ? t('knowledgeBase.uploadParsing') : t('knowledgeBase.uploadParseBtn')}
                  </Button>
                  <Button disabled={!stagedFiles.length || parsing} onClick={() => setStagedFiles([])}>
                    {t('knowledgeBase.uploadClearStaged')}
                  </Button>
                </Space>

                <div>
                  <Typography.Title level={5} style={{ marginTop: 0 }}>
                    {t('knowledgeBase.uploadPreviewTitle')}
                  </Typography.Title>
                  <Table
                    rowKey="key"
                    size="small"
                    columns={previewColumns}
                    dataSource={previewItems}
                    scroll={{ x: 1200 }}
                    pagination={false}
                    locale={{ emptyText: t('knowledgeBase.uploadEmpty') }}
                  />
                </div>

                <Space>
                  <Checkbox
                    checked={importableItems.length > 0 && selectedCount === importableItems.length}
                    indeterminate={selectedCount > 0 && selectedCount < importableItems.length}
                    disabled={!importableItems.length}
                    onChange={(event) =>
                      setPreviewItems((prev) =>
                        prev.map((item) => (item.ok ? { ...item, selected: event.target.checked } : item)),
                      )
                    }
                  >
                    {t('knowledgeBase.uploadSelectAll')}
                  </Checkbox>
                  <Button
                    type="primary"
                    icon={<ImportOutlined />}
                    loading={importingFiles}
                    disabled={!selectedCount}
                    onClick={() => void handleImportParsed()}
                  >
                    {importingFiles ? t('knowledgeBase.uploadImporting') : t('knowledgeBase.uploadImportBtn')}
                  </Button>
                </Space>
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={editing ? t('knowledgeBase.drawerEditTitle') : t('knowledgeBase.drawerCreateTitle')}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={720}
        destroyOnHidden
        footer={
          <Space style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button onClick={() => setDrawerOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => void handleSave()}>
              {t('common.save')}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" initialValues={{ is_active: true }}>
          <Form.Item name="title" label={t('knowledgeBase.title')} rules={[{ required: true, message: t('knowledgeBase.titleRequired') }]}>
            <Input placeholder={t('knowledgeBase.titlePlaceholder')} />
          </Form.Item>
          <Form.Item name="category" label={t('knowledgeBase.category')}>
            <Input placeholder={t('knowledgeBase.categoryPlaceholder')} />
          </Form.Item>
          <Form.Item name="tagsText" label={t('knowledgeBase.tags')}>
            <Input placeholder={t('knowledgeBase.tagsPlaceholder')} />
          </Form.Item>
          <Form.Item name="source_type" label={t('knowledgeBase.sourceType')}>
            <Input placeholder={t('knowledgeBase.sourceTypePlaceholder')} />
          </Form.Item>
          <Form.Item name="source_ref" label={t('knowledgeBase.sourceLink')}>
            <Input placeholder={t('knowledgeBase.sourceLinkPlaceholder')} />
          </Form.Item>
          <Form.Item name="content" label={t('knowledgeBase.content')} rules={[{ required: true, message: t('knowledgeBase.contentRequired') }]}>
            <Input.TextArea rows={10} placeholder={t('knowledgeBase.contentPlaceholder')} />
          </Form.Item>
          <Form.Item name="is_active" label={t('common.enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        open={Boolean(contentPreview)}
        title={`${t('knowledgeBase.uploadContentPreview')} · ${contentPreview?.title || ''}`}
        onCancel={() => setContentPreview(null)}
        width={760}
        footer={
          <Button onClick={() => setContentPreview(null)}>{t('common.close')}</Button>
        }
      >
        <Input.TextArea
          value={contentPreview?.content}
          readOnly
          autoSize={{ minRows: 14, maxRows: 24 }}
        />
      </Modal>
    </Card>
  );
}
