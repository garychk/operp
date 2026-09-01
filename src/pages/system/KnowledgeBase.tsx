import { useEffect, useMemo, useState } from "react";
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

const defaultImportText = `[
  {
    "title": "采购订单创建流程",
    "category": "采购",
    "tags": ["采购订单", "流程"],
    "source_type": "manual",
    "source_ref": "/system/knowledge-base",
    "content": "创建采购订单前，请先确认供应商、物料、数量、单价和税率是否完整。保存后再检查审批流是否配置正确。"
  }
]`;

function normalizeTags(value?: string | null) {
  return (value || "")
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function KnowledgeBase() {
  const [rows, setRows] = useState<KnowledgeDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
  const [importText, setImportText] = useState(defaultImportText);
  const [importing, setImporting] = useState(false);
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
      message.error("获取知识库文档失败");
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
      await logWithTiming("删除知识库文档", "DELETE", async () => {
        const { error } = await supabase
          .from("sys_ai_knowledge_docs")
          .delete()
          .eq("id", id);
        if (error) throw error;
      });
      message.success("删除成功");
      await fetchRows();
    } catch (error) {
      console.error(error);
      message.error("删除失败");
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
        message.warning("标题和内容不能为空");
        return;
      }

      if (editing) {
        await logWithTiming("更新知识库文档", "UPDATE", async () => {
          const { error } = await supabase
            .from("sys_ai_knowledge_docs")
            .update(payload)
            .eq("id", editing.id);
          if (error) throw error;
        });
      } else {
        await logWithTiming("创建知识库文档", "INSERT", async () => {
          const { error } = await supabase.from("sys_ai_knowledge_docs").insert({
            ...payload,
            created_at: new Date().toISOString(),
          });
          if (error) throw error;
        });
      }

      setDrawerOpen(false);
      message.success(editing ? "更新成功" : "创建成功");
      await fetchRows();
    } catch (error) {
      console.error(error);
      message.error("保存失败");
    }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const parsed = JSON.parse(importText) as ImportItem[];
      if (!Array.isArray(parsed) || !parsed.length) {
        message.warning("请提供至少一条知识库文档");
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
        message.warning("没有可导入的有效文档");
        return;
      }

      const { error } = await supabase.from("sys_ai_knowledge_docs").insert(payload);
      if (error) throw error;

      message.success(`已导入 ${payload.length} 条文档`);
      await fetchRows();
    } catch (error) {
      console.error(error);
      message.error("导入失败，请检查 JSON 格式");
    } finally {
      setImporting(false);
    }
  };

  const handleReindexHint = useMemo(
    () =>
      "保存或导入文档后，请在 ai-server 侧运行批量索引脚本生成 chunks 和 embeddings。",
    [],
  );

  const columns: ColumnsType<KnowledgeDoc> = [
    { title: "标题", dataIndex: "title", key: "title", ellipsis: true },
    { title: "分类", dataIndex: "category", key: "category", width: 120, render: (value) => value || "-" },
    {
      title: "标签",
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
    { title: "来源类型", dataIndex: "source_type", key: "source_type", width: 120, render: (value) => value || "-" },
    {
      title: "来源链接",
      dataIndex: "source_ref",
      key: "source_ref",
      width: 180,
      ellipsis: true,
      render: (value) => value || "-",
    },
    {
      title: "状态",
      dataIndex: "is_active",
      key: "is_active",
      width: 100,
      render: (value: boolean) => <Tag color={value ? "green" : "default"}>{value ? "启用" : "停用"}</Tag>,
    },
    { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 180 },
    {
      title: "操作",
      key: "action",
      width: 160,
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button type="text" icon={<EditOutlined />} onClick={() => openEdit(record)} />
          <Popconfirm title="确定删除这条文档吗？" onConfirm={() => void handleDelete(record.id)}>
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="知识库文档管理"
      extra={
        <Space>
          <Button icon={<SyncOutlined />} onClick={() => void fetchRows()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建文档
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
            label: "文档管理",
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
            label: "批量导入",
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size="large">
                <Card size="small" title="导入说明">
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    直接粘贴 JSON 数组，每个对象代表一篇文档。保存后再用 ai-server 批量索引脚本生成分片和向量。
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
                    导入文档
                  </Button>
                  <Button onClick={() => setImportText(defaultImportText)}>恢复示例</Button>
                </Space>
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={editing ? "编辑知识库文档" : "新建知识库文档"}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={720}
        destroyOnClose
        footer={
          <Space style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => void handleSave()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" initialValues={{ is_active: true }}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
            <Input placeholder="例如：采购订单创建流程" />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Input placeholder="例如：采购 / 销售 / 财务 / 系统" />
          </Form.Item>
          <Form.Item name="tagsText" label="标签">
            <Input placeholder="逗号分隔，例如：采购订单, 流程, 审批" />
          </Form.Item>
          <Form.Item name="source_type" label="来源类型">
            <Input placeholder="manual / import / page / doc 等" />
          </Form.Item>
          <Form.Item name="source_ref" label="来源链接">
            <Input placeholder="/system/knowledge-base 或 https://..." />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: "请输入内容" }]}>
            <Input.TextArea rows={10} placeholder="正文内容，建议写成可检索的操作说明或制度条款" />
          </Form.Item>
          <Form.Item name="is_active" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Drawer>
    </Card>
  );
}
