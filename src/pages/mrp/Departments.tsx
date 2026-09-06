import { useEffect, useState } from "react";
import { useTranslation } from 'react-i18next';
import type { Key } from "react";
import {
  Button,
  Input,
  Tag,
  Modal,
  Form,
  Select,
  Space,
  message,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { SuperTable } from "../../components/SuperTable";
import type { SuperTableColumn } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";

type Department = Tables["erp_departments_s_539dcf81_b"]["Row"];

const { Option } = Select;

const departmentTable = 'erp_departments_s_539dcf81_b';

export function Departments() {
  const { t } = useTranslation();
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(
    null,
  );
  const [form] = Form.useForm();

  useEffect(() => {
    fetchDepartments();
  }, []);

  const fetchDepartments = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(departmentTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setDepartments(data || []);
    } catch (error) {
      console.error("Error fetching departments:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingDepartment) {
        await logWithTiming("更新部门", "UPDATE", async () => {
          const { error } = await supabase
            .from(departmentTable)
            .update(values)
            .eq("id", editingDepartment.id);
          if (error) throw error;
        });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming("新增部门", "INSERT", async () => {
          const { error } = await supabase
            .from(departmentTable)
            .insert([values]);
          if (error) throw error;
        });
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingDepartment(null);
      fetchDepartments();
    } catch (error) {
      console.error("Error saving department:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = (record: Department) => {
    setEditingDepartment(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.departments.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming("删除部门", "DELETE", async () => {
            const { error } = await supabase
              .from(departmentTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
          });
          message.success(t("common.deleteSuccess"));
          fetchDepartments();
        } catch (error) {
          console.error("Error deleting department:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingDepartment(null);
    form.setFieldsValue({
      code: "",
      name: "",
      parent_id: undefined,
      manager_id: undefined,
      company_id: undefined,
      status: "active",
    });
    setIsModalOpen(true);
  };

  const getParentDepartmentName = (parentId: number | null) => {
    if (!parentId) return "-";
    const parent = departments.find((d) => d.id === parentId);
    return parent?.name || "-";
  };

  const filteredDepartments = departments.filter(
    (d) =>
      d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.code.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const columns: SuperTableColumn<Department>[] = [
    {
      title: t("mrp.departments.code"),
      dataIndex: "code",
      key: "code",
      width: 200,
    },
    {
      title: t("mrp.departments.name"),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("mrp.departments.parent"),
      dataIndex: "parent_id",
      key: "parent_id",
      width: 200,
      render: (parentId: number | null) => getParentDepartmentName(parentId),
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 200,
      render: (status: string | null) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? t("common.enabled") : t("mrp.inactive")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 200,
      fixed: "right",
      render: (_: any, record: Department) => (
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
        dataSource={filteredDepartments}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="departments"
        headerTitle={t("mrp.departments.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.departments.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.departments.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchDepartments}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={editingDepartment ? t("mrp.departments.edit") : t("mrp.departments.add")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingDepartment(null);
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
        width={400}
      >
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
          >
            <Form.Item
              label={t("mrp.departments.code")}
              name="code"
              rules={[{ required: true, message: t("mrp.departments.codePrompt") }]}
            >
              <Input
                placeholder={t("mrp.departments.codePrompt")}
                disabled={!!editingDepartment}
              />
            </Form.Item>
            <Form.Item
              label={t("mrp.departments.name")}
              name="name"
              rules={[{ required: true, message: t("mrp.departments.namePrompt") }]}
            >
              <Input placeholder={t("mrp.departments.namePrompt")} />
            </Form.Item>
            <Form.Item label={t("mrp.departments.parent")} name="parent_id">
              <Select placeholder={t("mrp.departments.parentPrompt")} allowClear>
                {departments
                  .filter((d) => d.id !== editingDepartment?.id)
                  .map((d) => (
                    <Option key={d.id} value={d.id}>
                      {d.name}
                    </Option>
                  ))}
              </Select>
            </Form.Item>
            <Form.Item label={t("common.status")} name="status" initialValue="active">
              <Select>
                <Option value="active">{t("common.enabled")}</Option>
                <Option value="inactive">{t("mrp.inactive")}</Option>
              </Select>
            </Form.Item>
          </Form>
      </SimpleModal>
    </div>
  );
}
