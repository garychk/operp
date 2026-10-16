import { useEffect, useMemo, useState } from "react";
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
  Image,
  Alert,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import { nextDocumentNo } from "../../utils/documentNaming";
import { Categories } from "./Categories";
import { ProductUoms } from "./ProductUoms";
import { ProductImages, IMAGE_BUCKET, imagePublicUrl } from "./ProductImages";
import { SupaModal, buildModalNav } from "../../components/SupaModal";
import { SuperTable } from "../../components/SuperTable";
import { formatMoney } from "../../utils/money";
import type { SuperTableColumn } from "../../components/SuperTable";
import SimpleModal from "../../components/SimpleModal";
import { useTranslation } from "react-i18next";
import { useUoms, buildUomOptions } from "../../hooks/useUoms";

type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type ProductCategory = Tables["erp_product_categories_s_539dcf81_b"]["Row"];

const productImageTable = "erp_product_images_s_539dcf81_b";

const { Option } = Select;
const productTable = "erp_products_s_539dcf81_b";
const supplierTable = "erp_suppliers_s_539dcf81_b";
const docType = "products";

/** 批量规则取值（与 deploy_60 CHECK、mrpEngine 一致） */
const LOT_POLICIES = ["lot_for_lot", "fixed_qty", "multiples", "max_qty"] as const;
/** 可「跟随类别默认」的计划参数列（deploy_120）：空值显式写 NULL */
const PLANNING_NULLABLE_FIELDS = [
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
  const [, setActiveTab] = useState("basic");
  const [form] = Form.useForm();
  /** 计划参数页签的独立表单实例（deploy_120）：保存时与主表单合并提交 */
  const [planningForm] = Form.useForm();
  /** 默认供应商下拉（仅启用中供应商，与采购订单页同口径） */
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([]);
  /** 产品 id -> 首图公开 URL（sort_order 最小者），列表缩略列使用 */
  const [firstImageUrls, setFirstImageUrls] = useState<Map<number, string>>(new Map());

  // 单位主数据（erp_uoms + erp_uom_groups）唯一入口 —— BOM 等页面共用同一实现，
  // 见 src/hooks/useUoms.ts。切勿再各自写一份查询。
  const { uoms, groups, uomMap, groupNameMap } = useUoms();
  const uomOptions = useMemo(
    () => buildUomOptions(uoms, groupNameMap, "id"),
    [uoms, groupNameMap],
  );

  useEffect(() => {
    fetchProducts();
    fetchCategories();
    fetchFirstImages();
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

  const fetchFirstImages = async () => {
    try {
      const { data, error } = await supabase
        .from(productImageTable)
        .select("product_id, bucket, storage_path")
        .eq("is_deleted", "n")
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;
      const map = new Map<number, string>();
      for (const row of data || []) {
        if (!map.has(row.product_id)) {
          map.set(row.product_id, imagePublicUrl(row.bucket || IMAGE_BUCKET, row.storage_path));
        }
      }
      setFirstImageUrls(map);
    } catch (error) {
      console.error("Error fetching product images:", error);
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
      const payload = { ...values };
      if (payload.base_uom_id) {
        const u = uomMap.get(payload.base_uom_id);
        payload.unit = u?.symbol || u?.name || payload.unit;
      }
      // 计划参数页签（deploy_120）：独立表单实例，getFieldsValue(true) 连未访问过的
      // 页签字段一起取（preserve 语义），保证「打开即保存」不丢数据。
      const planningValues = planningForm.getFieldsValue(true) as Record<string, unknown>;
      // 参与 MRP 三态转换：inherit → NULL（跟随物料属性）
      payload.is_mrp_relevant =
        planningValues.is_mrp_relevant === "inherit"
          ? null
          : planningValues.is_mrp_relevant === "yes"
            ? true
            : planningValues.is_mrp_relevant === "no"
              ? false
              : null;
      // 可空计划参数：空值显式写 NULL（= 跟随类别默认）；不能省略键，
      // 否则 update 分支清不掉旧值
      for (const field of PLANNING_NULLABLE_FIELDS) {
        payload[field] = planningValues[field] ?? null;
      }
      if (editingProduct) {
        await logWithTiming(t("products.logUpdate"), "UPDATE", async () => {
          const { error } = await supabase
            .from(productTable)
            .update(payload)
            .eq("id", editingProduct.id);
          if (error) throw error;
        }, { table: productTable, recordId: editingProduct.id });
        message.success(t("common.updateSuccess"));
      } else {
        const logParams: { table: string; recordId?: number } = { table: productTable };
        await logWithTiming(t("products.logCreate"), "INSERT", async () => {
          const { data, error } = await supabase
            .from(productTable)
            .insert([payload])
            .select("id")
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          setEditingProduct({ id: data.id } as Product);
        }, logParams);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      planningForm.resetFields();
      setEditingProduct(null);
      setActiveTab("basic");
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
      base_uom_id: record.base_uom_id ?? undefined,
      is_purchased: record.is_purchased ?? true,
      is_sold: record.is_sold ?? true,
      is_manufactured: record.is_manufactured ?? false,
    });
    // 计划参数页签（deploy_120，独立表单实例）
    // （生成类型 database.ts 早于 deploy_60/114/120，is_mrp_relevant 等列不在 Row 类型里，
    //   统一走 Record 视图读取）
    const rec = record as unknown as Record<string, unknown>;
    planningForm.setFieldsValue({
      // 参与 MRP 三态：null = 跟随物料属性
      is_mrp_relevant:
        rec.is_mrp_relevant === null || rec.is_mrp_relevant === undefined
          ? "inherit"
          : rec.is_mrp_relevant
            ? "yes"
            : "no",
      // 可空计划参数：null → undefined，控件显示为空（跟随类别默认）
      ...Object.fromEntries(
        PLANNING_NULLABLE_FIELDS.map((f) => [f, rec[f] ?? undefined]),
      ),
    });
    setActiveTab("basic");
    setIsModalOpen(true);
  };

  const handleAdd = async () => {
    let code: string;
    try {
      code = await nextDocumentNo(docType);
    } catch (error) {
      message.error(`${t("common.documentNoFailed")}：${(error as Error).message}`);
      return;
    }
    setEditingProduct(null);
    form.setFieldsValue({
      code,
      name: "",
      short_name: "",
      category_id: undefined,
      specification: "",
      base_uom_id: undefined,
      barcode: "",
      purchase_price: 0,
      sale_price: 0,
      cost_price: 0,
      is_purchased: true,
      is_sold: true,
      is_manufactured: false,
      status: "active",
      is_batch_managed: false,
      shelf_life_days: undefined,
    });
    // 计划参数页签（deploy_120）：新物料默认全部「跟随类别默认」
    planningForm.setFieldsValue({
      is_mrp_relevant: "inherit",
      ...Object.fromEntries(PLANNING_NULLABLE_FIELDS.map((f) => [f, undefined])),
    });
    setActiveTab("basic");
    setIsModalOpen(true);
  };

  const getCategoryName = (categoryId: number | null) => {
    const category = categories.find((c) => c.id === categoryId);
    return category?.name || "-";
  };

  const renderUnitCell = (record: Product) => {
    const u = record.base_uom_id ? uomMap.get(record.base_uom_id) : undefined;
    if (u) return `${u.name}${u.symbol ? ` (${u.symbol})` : ""}`;
    return record.unit || "-";
  };

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.code.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  /** 计划参数页签（deploy_120）：独立 Form 实例，与主表单同弹窗、保存时合并提交。
   *  可空字段留空 = 跟随类别默认（显式 0 仍是显式 0）。 */
  const planningFormEle = (
    <div style={{ marginRight: 12 }}>
    <Form form={planningForm} layout="vertical">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={t("products.planningTabHint")}
      />
      <Row gutter={16}>
        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.mrpRelevant")}
            name="is_mrp_relevant"
            initialValue="inherit"
          >
            <Select
              options={[
                { value: "inherit", label: t("mrp.planningParams.mrpRelevantInherit") },
                { value: "yes", label: t("common.yes") },
                { value: "no", label: t("common.no") },
              ]}
            />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.safetyStock")}
            name="safety_stock"
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.minStock")}
            name="min_stock"
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
          </Form.Item>
        </Col>

        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.maxStock")}
            name="max_stock"
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.orderPoint")}
            name="order_point"
            extra={t("mrp.planningParams.orderPointHint")}
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.lotPolicy")}
            name="lot_policy"
          >
            <Select
              allowClear
              placeholder={t("products.followCategoryDefault")}
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
          <Form.Item
            label={t("mrp.planningParams.minOrderQty")}
            name="min_order_qty"
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.orderMultiple")}
            name="order_multiple"
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.maxOrderQty")}
            name="max_order_qty"
            extra={t("mrp.planningParams.maxOrderQtyHint")}
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
          </Form.Item>
        </Col>

        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.leadTimePurchase")}
            name="lead_time_purchase"
            extra={t("mrp.planningParams.leadTimeHint")}
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item
            label={t("mrp.planningParams.leadTimeProduction")}
            name="lead_time_production"
          >
            <InputNumber style={{ width: "100%" }} min={0} placeholder={t("products.followCategoryDefault")} />
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
              placeholder={t("products.followCategoryDefault")}
              options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
        </Col>
      </Row>
    </Form>
    </div>
  );

  const columns: SuperTableColumn<Product>[] = [
    {
      title: t("products.images"),
      key: "first_image",
      width: 80,
      render: (_: any, record: Product) => {
        const url = firstImageUrls.get(record.id);
        if (!url) {
          return (
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 4,
                background: "#f5f5f5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#ccc",
                fontSize: 12,
              }}
            >
              -
            </div>
          );
        }
        return (
          <Image
            src={url}
            alt={record.name}
            width={48}
            height={48}
            style={{ objectFit: "cover", borderRadius: 4 }}
          />
        );
      },
    },
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
      title: t("products.baseUnit"),
      key: "base_uom_id",
      width: 140,
      render: (_: any, record: Product) => renderUnitCell(record),
    },
    {
      // 批次管理开关（deploy_106）：开了之后该物料过账必须带批次号，
      // 由 inventory_apply_move 在唯一漏斗处强制，不只是页面提示。
      title: t("products.batchManaged"),
      dataIndex: "is_batch_managed",
      key: "is_batch_managed",
      width: 150,
      render: (v: boolean, record: Product) => {
        if (!v) return <Tag>{t("products.batchManagedOff")}</Tag>;
        const days = (record as { shelf_life_days?: number | null }).shelf_life_days;
        return (
          <Tag color="blue">
            {days
              ? t("products.batchShelfLifeTag", { days })
              : t("products.batchManagedOn")}
          </Tag>
        );
      },
    },
    {
      title: t("products.purchasePrice"),
      dataIndex: "purchase_price",
      key: "purchase_price",
      width: 120,
      render: (price: number) => formatMoney(price),
    },
    {
      title: t("products.salePrice"),
      dataIndex: "sale_price",
      key: "sale_price",
      width: 120,
      render: (price: number) => formatMoney(price),
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
      fixed: "right",
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
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredProducts}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey={docType}
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
          planningForm.resetFields();
          setEditingProduct(null);
          setActiveTab("basic");
        }}
        headerPanelTitle={t("products.masterTitle")}
        historyTable={productTable}
        historyRecordId={editingProduct?.id}
        navigation={buildModalNav(filteredProducts, editingProduct?.id, handleEdit)}
        form={form}
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
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
                        <Form.Item label={t("products.spec")} name="specification">
                          <Input placeholder={t("products.specPlaceholder")} />
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
                      </Col>
                      <Col span={8}>
                        <Form.Item label={t("products.category")} name="category_id">
                          <Select placeholder={t("products.categoryPlaceholder")}>
                            {categories.map((c) => (
                              <Option key={c.id} value={c.id}>
                                {c.name}
                              </Option>
                            ))}
                          </Select>
                        </Form.Item>                        
                        <Form.Item
                          label={t("products.shelfLifeDays")}
                          name="shelf_life_days"
                          tooltip={t("products.shelfLifeDaysHint")}
                        >
                          <InputNumber
                            style={{ width: "100%" }}
                            min={1}
                            placeholder={t("products.shelfLifeDaysPlaceholder")}
                          />
                        </Form.Item>
                        <Form.Item
                          label={t("products.baseUnit")}
                          name="base_uom_id"
                          rules={[{ required: true, message: t("products.baseUnitRequired") }]}
                          tooltip={t("products.unitConvHint")}
                        >
                          <Select
                            showSearch
                            placeholder={t("products.baseUnitPlaceholder")}
                            optionFilterProp="label"
                            options={uomOptions}
                          />
                        </Form.Item>
                        <Form.Item label={t("common.status")} name="status" initialValue="active">
                          <Select>
                            <Option value="active">{t("common.enabled")}</Option>
                            <Option value="inactive">{t("products.disabled")}</Option>
                          </Select>
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={6}>
                        <Form.Item
                          label={t("products.purchasable")}
                          name="is_purchased"
                          valuePropName="checked"
                          initialValue={true}
                        >
                          <Checkbox />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item
                          label={t("products.sellable")}
                          name="is_sold"
                          valuePropName="checked"
                          initialValue={true}
                        >
                          <Checkbox />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item
                          label={t("products.manufacturable")}
                          name="is_manufactured"
                          valuePropName="checked"
                          initialValue={false}
                        >
                          <Checkbox />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item
                          label={t("products.batchManaged")}
                          name="is_batch_managed"
                          valuePropName="checked"
                          initialValue={false}
                          tooltip={t("products.batchManagedHint")}
                        >
                          <Checkbox />
                        </Form.Item>
                      </Col>
                    </Row>
          </Form>
        }
        detailItems={[
          {
            key: "planning",
            label: t("products.planningTab"),
            children: planningFormEle,
          },
          {
            key: "units",
            label: t("products.unitConversions"),
            disabled: !editingProduct,
            children: (
              <ProductUoms
                productId={editingProduct?.id}
                baseUomId={editingProduct?.base_uom_id}
                uoms={uoms}
                groups={groups}
              />
            ),
          },
          {
            key: "images",
            label: t("products.images"),
            disabled: !editingProduct,
            children: (
              <ProductImages
                productId={editingProduct?.id}
                onChanged={fetchFirstImages}
              />
            ),
          },
        ]}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={"80%"}
        height={'628px'}
        workflowDocumentType={docType}
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
