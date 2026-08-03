import { useEffect, useState } from "react";
import type { Key } from "react";
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

type WorkCenter = Tables["erp_work_centers_s_539dcf81_b"]["Row"];
type Department = Tables["erp_departments_s_539dcf81_b"]["Row"];

const { Option } = Select;

const workCenterTable = "erp_work_centers_s_539dcf81_b";

export function WorkCenters() {
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
      message.error("获取数据失败");
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
        message.success("更新成功");
      } else {
        await logWithTiming("新增工作中心", "INSERT", async () => {
          const { error } = await supabase
            .from(workCenterTable)
            .insert([values]);
          if (error) throw error;
        });
        message.success("新增成功");
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingWorkCenter(null);
      fetchWorkCenters();
    } catch (error) {
      console.error("Error saving work center:", error);
      message.error("保存失败");
    }
  };

  const handleEdit = (record: WorkCenter) => {
    setEditingWorkCenter(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: "确认删除",
      content: "确定要删除该工作中心吗？",
      onOk: async () => {
        try {
          await logWithTiming("删除工作中心", "DELETE", async () => {
            const { error } = await supabase
              .from(workCenterTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
          });
          message.success("删除成功");
          fetchWorkCenters();
        } catch (error) {
          console.error("Error deleting work center:", error);
          message.error("删除失败");
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
    machine: "机器",
    labor: "人工",
    mixed: "混合",
    other: "其他",
  };

  const columns = [
    {
      title: "编码",
      dataIndex: "code",
      key: "code",
    },
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
    },
    {
      title: "类型",
      dataIndex: "type",
      key: "type",
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: "所属部门",
      dataIndex: "department_id",
      key: "department_id",
      render: (departmentId: number) => getDepartmentName(departmentId),
    },
    {
      title: "日产能(小时)",
      dataIndex: "capacity_per_day",
      key: "capacity_per_day",
    },
    {
      title: "人工费率",
      dataIndex: "labor_rate",
      key: "labor_rate",
      render: (rate: number) => `¥${(rate ?? 0).toLocaleString()}/小时`,
    },
    {
      title: "制造费率",
      dataIndex: "overhead_rate",
      key: "overhead_rate",
      render: (rate: number) => `¥${(rate ?? 0).toLocaleString()}/小时`,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? "启用" : "停用"}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: WorkCenter) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id)}
          >
            删除
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
        headerTitle="工作中心管理"
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              新增工作中心
            </Button>
            <Input.Search
              allowClear
              placeholder="搜索工作中心名称或编码..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchWorkCenters}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <Modal
        title={editingWorkCenter ? "编辑工作中心" : "新增工作中心"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingWorkCenter(null);
        }}
        width={400}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              保存
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
            label="编码"
            name="code"
            rules={[{ required: true, message: "请输入编码" }]}
          >
            <Input placeholder="请输入编码" disabled={!!editingWorkCenter} />
          </Form.Item>
          <Form.Item
            label="名称"
            name="name"
            rules={[{ required: true, message: "请输入名称" }]}
          >
            <Input placeholder="请输入名称" />
          </Form.Item>
          <Form.Item label="类型" name="type" initialValue="machine">
            <Select>
              <Option value="machine">机器</Option>
              <Option value="labor">人工</Option>
              <Option value="mixed">混合</Option>
              <Option value="other">其他</Option>
            </Select>
          </Form.Item>
          <Form.Item label="所属部门" name="department_id">
            <Select placeholder="请选择部门">
              {departments.map((d) => (
                <Option key={d.id} value={d.id}>
                  {d.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="日产能(小时)"
            name="capacity_per_day"
            initialValue={8}
          >
            <InputNumber style={{ width: "100%" }} placeholder="请输入日产能" />
          </Form.Item>
          <Form.Item label="人工费率" name="labor_rate" initialValue={0}>
            <InputNumber
              style={{ width: "100%" }}
              placeholder="请输入人工费率"
            />
          </Form.Item>
          <Form.Item label="制造费率" name="overhead_rate" initialValue={0}>
            <InputNumber
              style={{ width: "100%" }}
              placeholder="请输入制造费率"
            />
          </Form.Item>
          <Form.Item label="状态" name="status" initialValue="active">
            <Select>
              <Option value="active">启用</Option>
              <Option value="inactive">停用</Option>
            </Select>
          </Form.Item>
        </Form>
        </Card>
      </Modal>
    </div>
  );
}
