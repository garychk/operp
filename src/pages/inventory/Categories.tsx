import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Table,
  Form,
  Select,
  Space,
  Card,
  message,
  Popconfirm,
} from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined } from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import SimpleModal from "@/components/SimpleModal";

const { Option } = Select;

type ProductCategory = Tables["erp_product_categories_s_539dcf81_b"]["Row"];

interface CategoryFormValues {
  code: string;
  name: string;
  parent_id?: number | null;
  type?: string | null;
}

export function Categories() {
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ProductCategory | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("erp_product_categories_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setCategories(data || []);
    } catch (error) {
      console.error("Error fetching categories:", error);
      message.error("获取物料类别失败");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: CategoryFormValues) => {
    try {
      if (editingCategory) {
        await logWithTiming("更新物料类别", "UPDATE", async () => {
          const { error } = await supabase
            .from("erp_product_categories_s_539dcf81_b")
            .update(values)
            .eq("id", editingCategory.id);
          if (error) {
            console.error("Error updating category:", error);
            throw error;
          }
        });
        message.success("更新成功");
      } else {
        await logWithTiming("新增物料类别", "INSERT", async () => {
          const { error } = await supabase
            .from("erp_product_categories_s_539dcf81_b")
            .insert([values]);
          if (error) {
            console.error("Error inserting category:", error);
            throw error;
          }
        });
        message.success("新增成功");
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingCategory(null);
      fetchCategories();
    } catch (error) {
      console.error("Error saving category:", error);
      message.error("保存失败");
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const { error } = await supabase
        .from("erp_product_categories_s_539dcf81_b")
        .update({ is_deleted: "y" })
        .eq("id", id);
      if (error) throw error;
      message.success("删除成功");
      fetchCategories();
    } catch (error) {
      console.error("Error deleting category:", error);
      message.error("删除失败");
    }
  };

  const handleEdit = (record: ProductCategory) => {
    setEditingCategory(record);
    form.setFieldsValue({
      ...record,
    });
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingCategory(null);
    form.setFieldsValue({
      code: "",
      name: "",
      parent_id: null,
      type: undefined,
    });
    setIsModalOpen(true);
  };

  const columns = [
    {
      title: "类别编码",
      dataIndex: "code",
      key: "code",
    },
    {
      title: "类别名称",
      dataIndex: "name",
      key: "name",
    },
    {
      title: "上级类别",
      dataIndex: "parent_id",
      key: "parent_id",
      render: (parentId: number | null) => {
        if (!parentId) return "-";
        const parent = categories.find((c) => c.id === parentId);
        return parent?.name || "-";
      },
    },
    {
      title: "类型",
      dataIndex: "type",
      key: "type",
      render: (type: string | null) => type || "-",
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: ProductCategory) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除"
            description="确定要删除该类别吗？"
            onConfirm={() => handleDelete(record.id)}
            okText="确认"
            cancelText="取消"
          >
            <Button type="text" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={false}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          新增类别
        </Button>
      }
    >
      <Table
        columns={columns}
        dataSource={categories}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <SimpleModal
        title={editingCategory ? "编辑类别" : "新增类别"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingCategory(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsModalOpen(false);
                form.resetFields();
                setEditingCategory(null);
              }}
            >
              取消
            </Button>
            <Button type="primary" onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
        width={500}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label="类别编码"
            name="code"
            rules={[{ required: true, message: "请输入类别编码" }]}
          >
            <Input placeholder="请输入类别编码" disabled={!!editingCategory} />
          </Form.Item>
          <Form.Item label="类别名称" name="name" rules={[{ required: true, message: "请输入类别名称" }]}>
            <Input placeholder="请输入类别名称" />
          </Form.Item>
          <Form.Item label="上级类别" name="parent_id">
            <Select allowClear placeholder="请选择上级类别">
              {categories
                .filter((c) => c.id !== editingCategory?.id)
                .map((c) => (
                  <Option key={c.id} value={c.id}>
                    {c.name}
                  </Option>
                ))}
            </Select>
          </Form.Item>
          <Form.Item label="类型" name="type">
            <Select allowClear placeholder="请选择类型">
              <Option value="product">产品</Option>
              <Option value="material">物料</Option>
              <Option value="service">服务</Option>
            </Select>
          </Form.Item>
        </Form>
      </SimpleModal>
    </Card>
  );
}