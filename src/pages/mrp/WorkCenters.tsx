import { useEffect, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  Button,
  Input,
  Tag,
  Modal,
  Form,
  Select,
  Space,
  message,
  InputNumber,
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

type WorkCenter = Tables["erp_work_centers_s_539dcf81_b"]["Row"];
type Department = Tables["erp_departments_s_539dcf81_b"]["Row"];

const { Option } = Select;

const workCenterTable = "erp_work_centers_s_539dcf81_b";

export function WorkCenters() {
  const { t } = useTranslation();
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingWorkCenter, setEditingWorkCenter] = useState<WorkCenter | null>(
    null,
  );
  const [form] = Form.useForm();

  useEffect(() => {
    fetchWorkCenters();
    fetchDepartments();
  }, []);

  const fetchWorkCenters = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(workCenterTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setWorkCenters(data || []);
    } catch (error) {
      console.error("Error fetching work centers:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchDepartments = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_departments_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setDepartments(data || []);
    } catch (error) {
      console.error("Error fetching departments:", error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingWorkCenter) {
        await logWithTiming("更新工作中心", "UPDATE", async () => {
          const { error } = await supabase
            .from(workCenterTable)
            .update(values)
            .eq("id", editingWorkCenter.id);
          if (error) throw error;
        });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming("新增工作中心", "INSERT", async () => {
          const { error } = await supabase
            .from(workCenterTable)
            .insert([values]);
          if (error) throw error;
        });
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingWorkCenter(null);
      fetchWorkCenters();
    } catch (error) {
      console.error("Error saving work center:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = (record: WorkCenter) => {
    setEditingWorkCenter(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.workCenters.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming("删除工作中心", "DELETE", async () => {
            const { error } = await supabase
              .from(workCenterTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
          });
          message.success(t("common.deleteSuccess"));
          fetchWorkCenters();
        } catch (error) {
          console.error("Error deleting work center:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingWorkCenter(null);
    form.setFieldsValue({
      code: "",
      name: "",
      type: "machine",
      department_id: undefined,
      capacity_per_day: 8,
      labor_rate: 0,
      overhead_rate: 0,
      status: "active",
    });
    setIsModalOpen(true);
  };

  const getDepartmentName = (departmentId: number | null) => {
    const department = departments.find((d) => d.id === departmentId);
    return department?.name || "-";
  };

  const filteredWorkCenters = workCenters.filter(
    (w) =>
      w.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      w.code.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const typeLabels: Record<string, string> = {
    machine: t("mrp.workCenters.typeMachine"),
    labor: t("mrp.workCenters.typeLabor"),
    mixed: t("mrp.workCenters.typeMixed"),
    other: t("mrp.workCenters.typeOther"),
  };

  const columns = [
    {
      title: t("common.code"),
      dataIndex: "code",
      key: "code",
      width: 200,
    },
    {
      title: t("common.name"),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("common.type"),
      dataIndex: "type",
      key: "type",
      width: 200,
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: t("mrp.workCenters.department"),
      dataIndex: "department_id",
      key: "department_id",
      render: (departmentId: number) => getDepartmentName(departmentId),
    },
    {
      title: t("mrp.workCenters.capacity"),
      dataIndex: "capacity_per_day",
      key: "capacity_per_day",
      width: 200,
    },
    {
      title: t("mrp.workCenters.laborRate"),
      dataIndex: "labor_rate",
      key: "labor_rate",
      width: 200,
      render: (rate: number) =>
        t("mrp.ratePerHour", { rate: (rate ?? 0).toLocaleString() }),
    },
    {
      title: t("mrp.workCenters.overheadRate"),
      dataIndex: "overhead_rate",
      key: "overhead_rate",
      width: 200,
      render: (rate: number) =>
        t("mrp.ratePerHour", { rate: (rate ?? 0).toLocaleString() }),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 200,
      render: (status: string) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? t("common.enabled") : t("mrp.inactive")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 200,
      render: (_: any, record: WorkCenter) => (
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
    <div className="mainContent">
      <SuperTable
        columns={columns}
        dataSource={filteredWorkCenters}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="work-centers"
        headerTitle={t("mrp.workCenters.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.workCenters.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.workCenters.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchWorkCenters}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={
          editingWorkCenter ? t("mrp.workCenters.edit") : t("mrp.workCenters.add")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingWorkCenter(null);
        }}
        width={400}
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
      >
        <Card size="small">
        <Form
          form={form}
          layout="horizontal"
          labelCol={{ span: 8 }}
          wrapperCol={{ span: 16 }}
          onFinish={handleSubmit}
        >
          <Form.Item
            label={t("common.code")}
            name="code"
            rules={[{ required: true, message: t("mrp.workCenters.codePrompt") }]}
          >
            <Input
              placeholder={t("mrp.workCenters.codePrompt")}
              disabled={!!editingWorkCenter}
            />
          </Form.Item>
          <Form.Item
            label={t("common.name")}
            name="name"
            rules={[{ required: true, message: t("mrp.workCenters.namePrompt") }]}
          >
            <Input placeholder={t("mrp.workCenters.namePrompt")} />
          </Form.Item>
          <Form.Item label={t("common.type")} name="type" initialValue="machine">
            <Select>
              <Option value="machine">{t("mrp.workCenters.typeMachine")}</Option>
              <Option value="labor">{t("mrp.workCenters.typeLabor")}</Option>
              <Option value="mixed">{t("mrp.workCenters.typeMixed")}</Option>
              <Option value="other">{t("mrp.workCenters.typeOther")}</Option>
            </Select>
          </Form.Item>
          <Form.Item
            label={t("mrp.workCenters.department")}
            name="department_id"
          >
            <Select placeholder={t("mrp.workCenters.departmentPrompt")}>
              {departments.map((d) => (
                <Option key={d.id} value={d.id}>
                  {d.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t("mrp.workCenters.capacity")}
            name="capacity_per_day"
            initialValue={8}
          >
            <InputNumber
              style={{ width: "100%" }}
              placeholder={t("mrp.workCenters.capacityPrompt")}
            />
          </Form.Item>
          <Form.Item
            label={t("mrp.workCenters.laborRate")}
            name="labor_rate"
            initialValue={0}
          >
            <InputNumber
              style={{ width: "100%" }}
              placeholder={t("mrp.workCenters.laborRatePrompt")}
            />
          </Form.Item>
          <Form.Item
            label={t("mrp.workCenters.overheadRate")}
            name="overhead_rate"
            initialValue={0}
          >
            <InputNumber
              style={{ width: "100%" }}
              placeholder={t("mrp.workCenters.overheadRatePrompt")}
            />
          </Form.Item>
          <Form.Item label={t("common.status")} name="status" initialValue="active">
            <Select>
              <Option value="active">{t("common.enabled")}</Option>
              <Option value="inactive">{t("mrp.inactive")}</Option>
            </Select>
          </Form.Item>
        </Form>
        </Card>
      </SimpleModal>
    </div>
  );
}
