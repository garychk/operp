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
import { useTranslation } from "react-i18next";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import SimpleModal from "../../components/SimpleModal";

const { Option } = Select;

type ProductCategory = Tables["erp_product_categories_s_539dcf81_b"]["Row"];

interface CategoryFormValues {
  code: string;
  name: string;
  parent_id?: number | null;
  type?: string | null;
}

/** 类型取值是写库的结构性事实，只有展示文案进 i18n。 */
const CATEGORY_TYPES = ["product", "material", "service"] as const;

export function Categories() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ProductCategory | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchCategories();
  }, []);

  const categoryTypeOptions = CATEGORY_TYPES.map((type) => ({
    value: type,
    label: t(`productCategories.typeOptions.${type}` as "productCategories.typeOptions.product"),
  }));
  const categoryTypeMap = new Map<string, string>(
    categoryTypeOptions.map((option) => [option.value, option.label])
  );

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
      message.error(t("productCategories.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: CategoryFormValues) => {
    try {
      if (editingCategory) {
        await logWithTiming(t("productCategories.logUpdate"), "UPDATE", async () => {
          const { error } = await supabase
            .from("erp_product_categories_s_539dcf81_b")
            .update(values)
            .eq("id", editingCategory.id);
          if (error) {
            console.error("Error updating category:", error);
            throw error;
          }
        });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(t("productCategories.logCreate"), "INSERT", async () => {
          const { error } = await supabase
            .from("erp_product_categories_s_539dcf81_b")
            .insert([values]);
          if (error) {
            console.error("Error inserting category:", error);
            throw error;
          }
        });
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingCategory(null);
      fetchCategories();
    } catch (error) {
      console.error("Error saving category:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const { error } = await supabase
        .from("erp_product_categories_s_539dcf81_b")
        .update({ is_deleted: "y" })
        .eq("id", id);
      if (error) throw error;
      message.success(t("common.deleteSuccess"));
      fetchCategories();
    } catch (error) {
      console.error("Error deleting category:", error);
      message.error(t("common.deleteFailed"));
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
      title: t("productCategories.code"),
      dataIndex: "code",
      key: "code",
    },
    {
      title: t("productCategories.name"),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("productCategories.parentCategory"),
      dataIndex: "parent_id",
      key: "parent_id",
      render: (parentId: number | null) => {
        if (!parentId) return "-";
        const parent = categories.find((c) => c.id === parentId);
        return parent?.name || "-";
      },
    },
    {
      title: t("productCategories.type"),
      dataIndex: "type",
      key: "type",
      render: (type: string | null) => (type ? categoryTypeMap.get(type) || type : "-"),
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: ProductCategory) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            {t("common.edit")}
          </Button>
          <Popconfirm
            title={t("common.confirmDelete")}
            description={t("productCategories.deleteConfirm")}
            onConfirm={() => handleDelete(record.id)}
            okText={t("common.ok")}
            cancelText={t("common.cancel")}
          >
            <Button type="text" danger icon={<DeleteOutlined />}>
              {t("common.delete")}
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
          {t("productCategories.addCategory")}
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
        title={editingCategory ? t("productCategories.editCategory") : t("productCategories.addCategory")}
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
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
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
            label={t("productCategories.code")}
            name="code"
            rules={[{ required: true, message: t("productCategories.codeRequired") }]}
          >
            <Input placeholder={t("productCategories.codePlaceholder")} disabled={!!editingCategory} />
          </Form.Item>
          <Form.Item
            label={t("productCategories.name")}
            name="name"
            rules={[{ required: true, message: t("productCategories.nameRequired") }]}
          >
            <Input placeholder={t("productCategories.namePlaceholder")} />
          </Form.Item>
          <Form.Item label={t("productCategories.parentCategory")} name="parent_id">
            <Select allowClear placeholder={t("productCategories.parentCategoryPlaceholder")}>
              {categories
                .filter((c) => c.id !== editingCategory?.id)
                .map((c) => (
                  <Option key={c.id} value={c.id}>
                    {c.name}
                  </Option>
                ))}
            </Select>
          </Form.Item>
          <Form.Item label={t("productCategories.type")} name="type">
            <Select allowClear placeholder={t("productCategories.typePlaceholder")} options={categoryTypeOptions} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </Card>
  );
}
