import { useEffect, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";

type Agv = Tables["erp_agvs_s_539dcf81_b"]["Row"];

const { Option } = Select;

const agvTable = "erp_agvs_s_539dcf81_b";

/**
 * AGV 小车主数据（`erp_agvs`，deploy_136 新增）。
 *
 * 3D 工厂驾驶舱新增了「AGV 小车」场景对象，它需要绑定一条 AGV 主数据；
 * 这张表就是那个绑定源。系统此前没有 AGV 对象，本页补上维护入口。
 *
 * `status` 是本表的启用位：active 启用 / inactive 停用。列表不过滤 status，
 * 停用的也要看得见，否则停用的 AGV 无法重新启用、历史绑定也会对不上。
 */
export function Agvs() {
  const { t } = useTranslation();
  const [agvs, setAgvs] = useState<Agv[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAgv, setEditingAgv] = useState<Agv | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    void fetchAgvs();
  }, []);

  const fetchAgvs = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(agvTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setAgvs(data || []);
    } catch (error) {
      console.error("Error fetching AGVs:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    const payload = {
      code: String(values.code || "").trim(),
      name: String(values.name || "").trim(),
      status: values.status || "active",
      remark: values.remark?.trim() || null,
    };

    try {
      if (editingAgv) {
        await logWithTiming(
          t("mrp.agvs.logUpdate"),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(agvTable)
              .update(payload)
              .eq("id", editingAgv.id);
            if (error) throw error;
          },
          { table: agvTable, recordId: editingAgv.id },
        );
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(
          t("mrp.agvs.logCreate"),
          "INSERT",
          async () => {
            const { error } = await supabase.from(agvTable).insert([payload]);
            if (error) throw error;
          },
          { table: agvTable },
        );
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingAgv(null);
      void fetchAgvs();
    } catch (error) {
      console.error("Error saving AGV:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = (record: Agv) => {
    setEditingAgv(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingAgv(null);
    form.setFieldsValue({
      code: "",
      name: "",
      status: "active",
      remark: "",
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.agvs.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.agvs.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(agvTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
            },
            { table: agvTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          void fetchAgvs();
        } catch (error) {
          console.error("Error deleting AGV:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const filteredAgvs = agvs.filter((a) => {
    const kw = searchTerm.toLowerCase();
    return (
      a.name.toLowerCase().includes(kw) || a.code.toLowerCase().includes(kw)
    );
  });

  const columns: SuperTableColumn<Agv>[] = [
    {
      title: t("common.code"),
      dataIndex: "code",
      key: "code",
      width: 180,
    },
    {
      title: t("common.name"),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("common.remark"),
      dataIndex: "remark",
      key: "remark",
      render: (v: string | null) => v || "-",
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 100,
      align: "center",
      render: (status: string | null) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? t("common.enabled") : t("common.disabled")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 180,
      fixed: "right",
      render: (_: any, record: Agv) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => void handleDelete(record.id)}
          >
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredAgvs}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="agvs"
        headerTitle={t("mrp.agvs.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.agvs.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.agvs.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchAgvs}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={editingAgv ? t("mrp.agvs.edit") : t("mrp.agvs.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingAgv(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={520}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          style={{ marginTop: 16 }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("common.code")}
                name="code"
                rules={[{ required: true, message: t("mrp.agvs.codePrompt") }]}
              >
                <Input
                  placeholder={t("mrp.agvs.codePrompt")}
                  disabled={!!editingAgv}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("common.name")}
                name="name"
                rules={[{ required: true, message: t("mrp.agvs.namePrompt") }]}
              >
                <Input placeholder={t("mrp.agvs.namePrompt")} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            label={t("common.status")}
            name="status"
            initialValue="active"
          >
            <Select>
              <Option value="active">{t("common.enabled")}</Option>
              <Option value="inactive">{t("common.disabled")}</Option>
            </Select>
          </Form.Item>
          <Form.Item label={t("common.remark")} name="remark">
            <Input.TextArea rows={2} placeholder={t("mrp.agvs.remarkPrompt")} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
