import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, EditOutlined, DeleteOutlined, ImportOutlined, SyncOutlined } from "@ant-design/icons";
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

  const handleReindex = async (docId?: number) => {
    // ai-server 走 service_role，绕过 RLS，必须显式告诉它索引哪个租户的文档；
    // 不带 tenant_id 时它只会扫 tenant_id IS NULL 的平台基线行，结果恒为 total=0。
    if (!user?.tenantId) {
      message.warning(t('knowledgeBase.reindexNoTenant'));
      return;
    }
    setReindexing(true);
    try {
      // ai-server 已启用 JWT 鉴权：租户以 Authorization 头解析为准
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const response = await fetch(`${AI_SERVER_URL}/knowledge/reindex`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          ...(Number.isFinite(docId) ? { doc_id: docId } : {}),
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
    </Card>
  );
}
