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
  InputNumber,
  Alert,
  Row,
  Col,
} from "antd";
import { PlusOutlined, EditOutlined, DeleteOutlined, SettingOutlined } from "@ant-design/icons";
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

/** 类别默认参数列（deploy_120）：与 erp_products 计划参数同名，NULL = 未设置 */
const CATEGORY_DEFAULT_FIELDS = [
  "safety_stock",
  "min_stock",
  "max_stock",
  "order_point",
  "lot_policy",
  "min_order_qty",
  "order_multiple",
  "max_order_qty",
  "lead_time_purchase",
  "lead_time_production",
  "default_supplier_id",
] as const;

const LOT_POLICIES = ["lot_for_lot", "fixed_qty", "multiples", "max_qty"] as const;
const supplierTable = "erp_suppliers_s_539dcf81_b";

export function Categories() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ProductCategory | null>(null);
  const [form] = Form.useForm();
  // deploy_120：类别默认参数
  const [isDefaultsOpen, setIsDefaultsOpen] = useState(false);
  const [defaultsCategory, setDefaultsCategory] = useState<ProductCategory | null>(null);
  const [defaultsForm] = Form.useForm();
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    fetchCategories();
    fetchSuppliers();
  }, []);

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from(supplierTable)
        .select("id, name")
        .eq("is_deleted", "n")
        .eq("status", "active")
        .order("name", { ascending: true });
      if (error) throw error;
      setSuppliers(data || []);
    } catch (error) {
      console.error("Error fetching suppliers:", error);
    }
  };

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

  // ---------------------------------------------------------------------
  // deploy_120：类别默认参数编辑（独立弹窗，不塞进 500px 新建/编辑表单）
  // ---------------------------------------------------------------------
  const handleOpenDefaults = (record: ProductCategory) => {
    setDefaultsCategory(record);
    defaultsForm.setFieldsValue({
      ...Object.fromEntries(
        CATEGORY_DEFAULT_FIELDS.map((f) => [
          f,
          (record as unknown as Record<string, unknown>)[f] ?? undefined,
        ]),
      ),
    });
    setIsDefaultsOpen(true);
  };

  const handleDefaultsSubmit = async (values: Record<string, unknown>) => {
    if (!defaultsCategory) return;
    // 空值显式写 NULL：清掉类别默认 = 物料回退到引擎默认
    const patch: Record<string, unknown> = {};
    for (const field of CATEGORY_DEFAULT_FIELDS) {
      patch[field] = values[field] ?? null;
    }
    try {
      setSavingDefaults(true);
      await logWithTiming(t("productCategories.defaultParamsLog"), "UPDATE", async () => {
        const { error } = await supabase
          .from("erp_product_categories_s_539dcf81_b")
          .update(patch)
          .eq("id", defaultsCategory.id);
        if (error) throw error;
      });
      message.success(t("productCategories.defaultParamsSaved"));
      setIsDefaultsOpen(false);
      defaultsForm.resetFields();
      setDefaultsCategory(null);
      fetchCategories();
    } catch (error) {
      console.error("Error saving category default params:", error);
      message.error(`${t("common.saveFailed")}：${(error as Error).message}`);
    } finally {
      setSavingDefaults(false);
    }
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
            icon={<SettingOutlined />}
            onClick={() => handleOpenDefaults(record)}
          >
            {t("productCategories.defaultParams")}
          </Button>
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

      {/* deploy_120：类别默认参数（独立弹窗；空值 = 未设置，NULL 落库） */}
      <SimpleModal
        title={`${t("productCategories.defaultParamsTitle")} - ${defaultsCategory?.name ?? ""}`}
        open={isDefaultsOpen}
        onCancel={() => {
          setIsDefaultsOpen(false);
          defaultsForm.resetFields();
          setDefaultsCategory(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsDefaultsOpen(false);
                defaultsForm.resetFields();
                setDefaultsCategory(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" loading={savingDefaults} onClick={() => defaultsForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={760}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t("productCategories.defaultParamsHint")}
        />
        <Form form={defaultsForm} layout="vertical" onFinish={handleDefaultsSubmit}>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label={t("mrp.planningParams.safetyStock")} name="safety_stock">
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t("mrp.planningParams.minStock")} name="min_stock">
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t("mrp.planningParams.maxStock")} name="max_stock">
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>

            <Col span={8}>
              <Form.Item
                label={t("mrp.planningParams.orderPoint")}
                name="order_point"
                extra={t("mrp.planningParams.orderPointHint")}
              >
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t("mrp.planningParams.lotPolicy")} name="lot_policy">
                <Select
                  allowClear
                  placeholder={t("productCategories.notSet")}
                  options={LOT_POLICIES.map((value) => ({
                    value,
                    label: {
                      lot_for_lot: t("mrp.planningParams.lotPolicyLotForLot"),
                      fixed_qty: t("mrp.planningParams.lotPolicyFixedQty"),
                      multiples: t("mrp.planningParams.lotPolicyMultiples"),
                      max_qty: t("mrp.planningParams.lotPolicyMaxQty"),
                    }[value],
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t("mrp.planningParams.minOrderQty")} name="min_order_qty">
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>

            <Col span={8}>
              <Form.Item label={t("mrp.planningParams.orderMultiple")} name="order_multiple">
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.planningParams.maxOrderQty")}
                name="max_order_qty"
                extra={t("mrp.planningParams.maxOrderQtyHint")}
              >
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t("mrp.planningParams.leadTimePurchase")} name="lead_time_purchase">
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>

            <Col span={8}>
              <Form.Item
                label={t("mrp.planningParams.leadTimeProduction")}
                name="lead_time_production"
              >
                <InputNumber style={{ width: "100%" }} min={0} placeholder={t("productCategories.notSet")} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("products.defaultSupplier")}
                name="default_supplier_id"
                tooltip={t("products.defaultSupplierHint")}
              >
                <Select
                  showSearch
                  allowClear
                  optionFilterProp="label"
                  placeholder={t("productCategories.notSet")}
                  options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>
    </Card>
  );
}
