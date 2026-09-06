import { useEffect, useState } from "react";
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
  InputNumber,
  Checkbox,
  Row,
  Col,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { supabase } from "@/utils/supabase";
import type { Tables } from "@/utils/supabase";
import { logWithTiming } from "@/utils/logger";
import { Categories } from "./Categories";
import { SupaModal } from "@/components/SupaModal";
import { SuperTable } from "@/components/SuperTable";
import DictSelect from "@/components/DictSelect";
import SimpleModal from "@/components/SimpleModal";
import { useTranslation } from "react-i18next";

type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type ProductCategory = Tables["erp_product_categories_s_539dcf81_b"]["Row"];

const { Option } = Select;
const productTable = "erp_products_s_539dcf81_b";

export function Products() {
  const { t } = useTranslation();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchProducts();
    fetchCategories();
  }, []);

  const fetchProducts = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(productTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_product_categories_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setCategories(data || []);
    } catch (error) {
      console.error("Error fetching categories:", error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingProduct) {
        await logWithTiming(t("products.logUpdate"), "UPDATE", async () => {
          const { error } = await supabase
            .from(productTable)
            .update(values)
            .eq("id", editingProduct.id);
          if (error) throw error;
        }, { table: productTable, recordId: editingProduct.id });
        message.success(t("common.updateSuccess"));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: productTable,
        };
        await logWithTiming(t("products.logCreate"), "INSERT", async () => {
          const { data, error } = await supabase
            .from(productTable)
            .insert([values])
            .select("id")
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
        }, logParams);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingProduct(null);
      fetchProducts();
    } catch (error) {
      console.error("Error saving product:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("products.deleteConfirm"),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(productTable)
            .update({ is_deleted: "y" })
            .eq("id", id);
          if (error) throw error;
          message.success(t("common.deleteSuccess"));
          fetchProducts();
        } catch (error) {
          console.error("Error deleting product:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleEdit = (record: Product) => {
    setEditingProduct(record);
    form.setFieldsValue({
      ...record,
      is_purchased: record.is_purchased ?? true,
      is_sold: record.is_sold ?? true,
      is_manufactured: record.is_manufactured ?? false,
    });
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingProduct(null);
    form.setFieldsValue({
      code: "",
      name: "",
      short_name: "",
      category_id: undefined,
      specification: "",
      unit: t("products.unitDefault"),
      barcode: "",
      purchase_price: 0,
      sale_price: 0,
      cost_price: 0,
      safety_stock: 0,
      max_stock: 0,
      min_stock: 0,
      is_purchased: true,
      is_sold: true,
      is_manufactured: false,
      status: "active",
    });
    setIsModalOpen(true);
  };

  const getCategoryName = (categoryId: number | null) => {
    const category = categories.find((c) => c.id === categoryId);
    return category?.name || "-";
  };

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.code.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const columns = [
    {
      title: t("products.code"),
      dataIndex: "code",
      key: "code",
      width: 160,
    },
    {
      title: t("products.name"),
      dataIndex: "name",
      key: "name",
    },
    {
      title: t("products.category"),
      dataIndex: "category_id",
      key: "category_id",
      width: 120,
      render: (categoryId: number) => getCategoryName(categoryId),
    },
    {
      title: t("products.spec"),
      dataIndex: "specification",
      key: "specification",
      width: 280,
      render: (text: string) => text || "-",
    },
    {
      title: t("products.unit"),
      dataIndex: "unit",
      key: "unit",
      width: 120,
    },
    {
      title: t("products.purchasePrice"),
      dataIndex: "purchase_price",
      key: "purchase_price",
      width: 120,
      render: (price: number) => `¥${(price ?? 0).toLocaleString()}`,
    },
    {
      title: t("products.salePrice"),
      dataIndex: "sale_price",
      key: "sale_price",
      width: 120,
      render: (price: number) => `¥${(price ?? 0).toLocaleString()}`,
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (status: string) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? t("common.enabled") : t("products.disabled")}
        </Tag>
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 120,
      render: (_: any, record: Product) => (
        <Space>
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
        dataSource={filteredProducts}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="products"
        tableName={productTable}
        headerTitle={t("products.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        onImport={() => console.log("importData")}
        onDataChanged={fetchProducts}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("products.addMaterial")}
            </Button>
            <Button
              icon={<SettingOutlined />}
              onClick={() => setIsCategoryModalOpen(true)}
            >
              {t("products.categoryManage")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("products.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchProducts}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={editingProduct ? t("products.editMaterial") : t("products.addMaterial")}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingProduct(null);
        }}
        headerPanelTitle={t("products.masterTitle")}
        historyTable={productTable}
        historyRecordId={editingProduct?.id}
        form={form}
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
            style={{ padding: "0 16px 0 0" }}
          >
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label={t("products.code")}
                  name="code"
                  rules={[{ required: true, message: t("products.codeRequired") }]}
                >
                  <Input
                    placeholder={t("products.codePlaceholder")}
                    disabled={!!editingProduct}
                  />
                </Form.Item>
                <Form.Item
                  label={t("products.name")}
                  name="name"
                  rules={[{ required: true, message: t("products.nameRequired") }]}
                >
                  <Input placeholder={t("products.namePlaceholder")} />
                </Form.Item>
                <Form.Item label={t("products.shortName")} name="short_name">
                  <Input placeholder={t("products.shortNamePlaceholder")} />
                </Form.Item>
                <Form.Item label={t("products.category")} name="category_id">
                  <Select placeholder={t("products.categoryPlaceholder")}>
                    {categories.map((c) => (
                      <Option key={c.id} value={c.id}>
                        {c.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label={t("products.spec")} name="specification">
                  <Input placeholder={t("products.specPlaceholder")} />
                </Form.Item>
                <Form.Item
                  label={t("products.unit")}
                  name="unit"
                  initialValue={t("products.unitDefault")}
                  tooltip={t("products.unitTooltip")}
                >
                  <DictSelect
                    dictType="uom"
                    placeholder={t("products.unitPlaceholder")}
                    allowClear
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label={t("products.barcode")} name="barcode">
                  <Input placeholder={t("products.barcodePlaceholder")} />
                </Form.Item>
                <Form.Item
                  label={t("products.purchasePrice")}
                  name="purchase_price"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("products.purchasePricePlaceholder")}
                  />
                </Form.Item>
                <Form.Item label={t("products.salePrice")} name="sale_price" initialValue={0}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("products.salePricePlaceholder")}
                  />
                </Form.Item>
                <Form.Item label={t("products.costPrice")} name="cost_price" initialValue={0}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("products.costPricePlaceholder")}
                  />
                </Form.Item>
                <Form.Item
                  label={t("products.safetyStock")}
                  name="safety_stock"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("products.safetyStockPlaceholder")}
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label={t("products.maxStock")} name="max_stock" initialValue={0}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("products.maxStockPlaceholder")}
                  />
                </Form.Item>
                <Form.Item label={t("products.minStock")} name="min_stock" initialValue={0}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("products.minStockPlaceholder")}
                  />
                </Form.Item>
                <Form.Item
                  label={t("products.purchasable")}
                  name="is_purchased"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
                </Form.Item>
                <Form.Item
                  label={t("products.sellable")}
                  name="is_sold"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
                </Form.Item>
                <Form.Item
                  label={t("products.manufacturable")}
                  name="is_manufactured"
                  valuePropName="checked"
                  initialValue={false}
                >
                  <Checkbox />
                </Form.Item>
                <Form.Item label={t("common.status")} name="status" initialValue="active">
                  <Select>
                    <Option value="active">{t("common.enabled")}</Option>
                    <Option value="inactive">{t("products.disabled")}</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={"70%"}
        height={650}
      />
      <SimpleModal
        title={t("products.categoryManageTitle")}
        open={isCategoryModalOpen}
        onCancel={() => setIsCategoryModalOpen(false)}
        footer={null}
        width={800}
        destroyOnHidden
      >
        <Categories />
      </SimpleModal>  
    </div>
  );
}
