import { useEffect, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Input,
  Tag,
  Modal,
  Form,
  Select,
  Space,
  message,
  InputNumber,
  Row,
  Col,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import SimpleModal from "../../components/SimpleModal";

type Operation = Tables["erp_operations_s_539dcf81_b"]["Row"];
type WorkCenter = Tables["erp_work_centers_s_539dcf81_b"]["Row"];

const { Option } = Select;
const { TextArea } = Input;

const operationTable = 'erp_operations_s_539dcf81_b';

export function Operations() {
  const { t } = useTranslation();
  const [operations, setOperations] = useState<Operation[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingOperation, setEditingOperation] = useState<Operation | null>(
    null,
  );
  const [form] = Form.useForm();

  useEffect(() => {
    fetchOperations();
    fetchWorkCenters();
  }, []);

  const fetchOperations = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(operationTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setOperations(data || []);
    } catch (error) {
      console.error("Error fetching operations:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchWorkCenters = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_work_centers_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setWorkCenters(data || []);
    } catch (error) {
      console.error("Error fetching work centers:", error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingOperation) {
        await logWithTiming("更新工序", "UPDATE", async () => {
          const { error } = await supabase
            .from(operationTable)
            .update(values)
            .eq("id", editingOperation.id);
          if (error) throw error;
        });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming("新增工序", "INSERT", async () => {
          const { error } = await supabase
            .from(operationTable)
            .insert([values]);
          if (error) throw error;
        });
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingOperation(null);
      fetchOperations();
    } catch (error) {
      console.error("Error saving operation:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = (record: Operation) => {
    setEditingOperation(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.operations.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming("删除工序", "DELETE", async () => {
            const { error } = await supabase
              .from(operationTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
          });
          message.success(t("common.deleteSuccess"));
          fetchOperations();
        } catch (error) {
          console.error("Error deleting operation:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingOperation(null);
    form.setFieldsValue({
      code: "",
      name: "",
      description: "",
      work_center_id: undefined,
      standard_hours: 0,
      setup_hours: 0,
      labor_rate: 0,
      overhead_rate: 0,
      status: "active",
    });
    setIsModalOpen(true);
  };

  const getWorkCenterName = (workCenterId: number | null) => {
    const workCenter = workCenters.find((w) => w.id === workCenterId);
    return workCenter?.name || "-";
  };

  const filteredOperations = operations.filter(
    (o) =>
      o.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      o.code.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const columns = [
    {
      title: t("mrp.operations.code"),
      dataIndex: "code",
      key: "code",
    },
    {
      title: t("mrp.operations.name"),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("mrp.operations.workCenter"),
      dataIndex: "work_center_id",
      key: "work_center_id",
      render: (workCenterId: number) => getWorkCenterName(workCenterId),
    },
    {
      title: t("mrp.operations.standardHours"),
      dataIndex: "standard_hours",
      key: "standard_hours",
      render: (hours: number) => t("mrp.hoursAmount", { hours: hours }),
    },
    {
      title: t("mrp.operations.setupHours"),
      dataIndex: "setup_hours",
      key: "setup_hours",
      render: (hours: number) => t("mrp.hoursAmount", { hours: hours }),
    },
    {
      title: t("mrp.operations.laborRate"),
      dataIndex: "labor_rate",
      key: "labor_rate",
      render: (rate: number) => t("mrp.ratePerHour", { rate: (rate ?? 0).toLocaleString() }),
    },
    {
      title: t("mrp.operations.overheadRate"),
      dataIndex: "overhead_rate",
      key: "overhead_rate",
      render: (rate: number) =>
        t("mrp.ratePerHour", { rate: (rate ?? 0).toLocaleString() }),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? t("common.enabled") : t("mrp.inactive")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: Operation) => (
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
            onClick={() => handleDelete(record.id)}
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
        dataSource={filteredOperations}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="operations"
        headerTitle={t("mrp.operations.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.operations.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.operations.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchOperations}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={editingOperation ? t("mrp.operations.edit") : t("mrp.operations.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingOperation(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={600}
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
                label={t("mrp.operations.code")}
                name="code"
                rules={[{ required: true, message: t("mrp.operations.codePrompt") }]}
              >
                <Input
                  placeholder={t("mrp.operations.codePrompt")}
                  disabled={!!editingOperation}
                />
              </Form.Item>
              <Form.Item
                label={t("mrp.operations.name")}
                name="name"
                rules={[{ required: true, message: t("mrp.operations.namePrompt") }]}
              >
                <Input placeholder={t("mrp.operations.namePrompt")} />
              </Form.Item>
              <Form.Item label={t("mrp.operations.description")} name="description">
                <TextArea rows={3} placeholder={t("mrp.operations.descriptionPrompt")} />
              </Form.Item>
              <Form.Item label={t("mrp.operations.workCenter")} name="work_center_id">
                <Select placeholder={t("mrp.operations.workCenterPrompt")}>
                  {workCenters.map((w) => (
                    <Option key={w.id} value={w.id}>
                      {w.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.operations.standardHoursUnit")}
                name="standard_hours"
                initialValue={0}
              >
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder={t("mrp.operations.standardHoursPrompt")}
                />
              </Form.Item>
              <Form.Item
                label={t("mrp.operations.setupHoursUnit")}
                name="setup_hours"
                initialValue={0}
              >
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder={t("mrp.operations.setupHoursPrompt")}
                />
              </Form.Item>
              <Form.Item label={t("mrp.operations.laborRate")} name="labor_rate" initialValue={0}>
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder={t("mrp.operations.laborRatePrompt")}
                />
              </Form.Item>
              <Form.Item label={t("mrp.operations.overheadRate")} name="overhead_rate" initialValue={0}>
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder={t("mrp.operations.overheadRatePrompt")}
                />
              </Form.Item>
              <Form.Item label={t("common.status")} name="status" initialValue="active">
                <Select>
                  <Option value="active">{t("common.enabled")}</Option>
                  <Option value="inactive">{t("mrp.inactive")}</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>
    </div>
  );
}
