import { useEffect, useMemo, useState } from "react";
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
  DatePicker,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import { SuperTable } from "../../components/SuperTable";
import { formatMoney } from "../../utils/money";
import SimpleModal from "../../components/SimpleModal";
import dayjs from "dayjs";

type ProductionReceipt = Tables["erp_production_receipts_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type ProductionOrder = Tables["erp_production_orders_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];
type Bin = Tables["erp_bins_s_539dcf81_b"]["Row"];

const { Option } = Select;
const receiptTable = "erp_production_receipts_s_539dcf81_b";

// 与 deploy_56 / deploy_58 的 post_production_document / reverse_production_document 对应
const POST_DOCUMENT_RPC = "post_production_document";
const REVERSE_DOCUMENT_RPC = "reverse_production_document";
const DOCUMENT_TYPE = "production_receipt";
// RPC 允许过账的来源状态；cancelled 与 posted 不在其中
const POSTABLE_STATUSES = ["draft", "approved", "issued"];
const POSTED_STATUS = "posted";
const DRAFT_STATUS = "draft";
const CANCELLED_STATUS = "cancelled";

// 质检结论是写库取值，留在代码里；只有标签进 i18n
const QUALITY_STATUSES = ["qualified", "unqualified", "pending"] as const;

const isPosted = (record: { status: string | null }) =>
  record.status === POSTED_STATUS;

const formatQuantity = (value: number | null | undefined) =>
  Number(value ?? 0).toLocaleString();

const formatDateTime = (value: string | null | undefined) =>
  value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";

export function ProductionReceipts() {
  const { t } = useTranslation();
  const [receipts, setReceipts] = useState<ProductionReceipt[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<ProductionReceipt | null>(
    null,
  );
  const [form] = Form.useForm();
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState(false);
  // 库位下拉依赖当前表单里选的仓库，用受控值驱动重渲染
  const [formWarehouseId, setFormWarehouseId] = useState<number | undefined>();

  useEffect(() => {
    fetchReceipts();
    fetchProducts();
    fetchOrders();
    fetchWarehouses();
    fetchBins();
  }, []);

  const fetchReceipts = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(receiptTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("receipt_date", { ascending: false });
      if (error) throw error;
      setReceipts(data || []);
    } catch (error) {
      console.error("Error fetching production receipts:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
    }
  };

  const fetchOrders = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_production_orders_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Error fetching production orders:", error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_warehouses_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error("Error fetching warehouses:", error);
    }
  };

  const fetchBins = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_bins_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setBins(data || []);
    } catch (error) {
      console.error("Error fetching bins:", error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload: any = {
        ...values,
        receipt_date: values.receipt_date
          ? dayjs(values.receipt_date).format("YYYY-MM-DD")
          : null,
        // amount 是过账时的总成本口径，按 数量 × 单位成本 落库
        amount: Number(values.quantity || 0) * Number(values.unit_cost || 0),
        location_id: values.location_id ?? null,
      };

      if (editingReceipt) {
        await logWithTiming(
          t("mrp.productionReceipts.logUpdate"),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(receiptTable)
              .update(payload)
              .eq("id", editingReceipt.id);
            if (error) throw error;
          },
          { table: receiptTable, recordId: editingReceipt.id },
        );
        message.success(t("common.updateSuccess"));
      } else {
        payload.is_deleted = "n";
        await logWithTiming(
          t("mrp.productionReceipts.logCreate"),
          "INSERT",
          async () => {
            const { error } = await supabase
              .from(receiptTable)
              .insert([payload]);
            if (error) throw error;
          },
          { table: receiptTable },
        );
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReceipt(null);
      setFormWarehouseId(undefined);
      fetchReceipts();
    } catch (error: any) {
      console.error("Error saving production receipt:", error);
      message.error(error?.message || t("common.saveFailed"));
    }
  };

  const handleEdit = (record: ProductionReceipt) => {
    if (isPosted(record)) {
      message.warning(t("mrp.productionReceipts.postedLocked"));
      return;
    }
    setEditingReceipt(record);
    setFormWarehouseId(record.warehouse_id ?? undefined);
    form.setFieldsValue({
      ...record,
      receipt_date: record.receipt_date ? dayjs(record.receipt_date) : undefined,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = receipts.find((r) => r.id === id);
    if (target && isPosted(target)) {
      message.warning(t("mrp.productionReceipts.postedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.productionReceipts.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.productionReceipts.logDelete"),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(receiptTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
            },
            { table: receiptTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          fetchReceipts();
        } catch (error) {
          console.error("Error deleting production receipt:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  // 过账 / 反过账走工具栏按钮，作用于当前勾选的完工入库单（支持多选批量）。
  // 逐单执行而非单事务批处理：一张失败不影响其它张，失败原因逐条汇总。
  const runSequential = async (
    targets: ProductionReceipt[],
    action: (record: ProductionReceipt) => Promise<void>,
    fallbackMessage: string,
  ) => {
    let success = 0;
    const failures: string[] = [];
    for (const record of targets) {
      try {
        await action(record);
        success += 1;
      } catch (error: any) {
        console.error("Error running production receipt batch action:", error);
        failures.push(
          `${record.receipt_no}：${error?.message || fallbackMessage}`,
        );
      }
    }
    setSelectedRowKeys([]);
    await fetchReceipts();
    return { success, failures };
  };

  const handleBatchPost = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = receipts.filter(
      (row) =>
        selectedIds.has(row.id) &&
        POSTABLE_STATUSES.includes((row.status || "").toLowerCase()),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.productionReceipts.postNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.productionReceipts.post"),
      content: t("mrp.productionReceipts.postConfirmContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setPosting(true);
        try {
          const { success, failures } = await runSequential(
            targets,
            async (record) => {
              const { error } = await supabase.rpc(POST_DOCUMENT_RPC, {
                p_document_type: DOCUMENT_TYPE,
                p_document_id: record.id,
                p_idempotency_key: crypto.randomUUID(),
              });
              if (error) throw error;
            },
            t("mrp.productionReceipts.postFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.productionReceipts.postSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.productionReceipts.postPartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
        } finally {
          setPosting(false);
        }
      },
    });
  };

  const handleBatchReverse = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = receipts.filter(
      (row) => selectedIds.has(row.id) && isPosted(row),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.productionReceipts.reverseNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.productionReceipts.reverse"),
      content: t("mrp.productionReceipts.reverseConfirmContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setReversing(true);
        try {
          const { success, failures } = await runSequential(
            targets,
            async (record) => {
              const { error } = await supabase.rpc(REVERSE_DOCUMENT_RPC, {
                p_document_type: DOCUMENT_TYPE,
                p_document_id: record.id,
                p_idempotency_key: crypto.randomUUID(),
              });
              if (error) throw error;
            },
            t("mrp.productionReceipts.reverseFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.productionReceipts.reverseSuccessMany", {
                count: success,
              }),
            );
          } else {
            message.error(
              t("mrp.productionReceipts.reversePartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
        } finally {
          setReversing(false);
        }
      },
    });
  };

  const handleAdd = async () => {
    let receiptNo: string;
    try {
      receiptNo = await nextDocumentNo(DOCUMENT_TYPE);
    } catch (error) {
      message.error(
        `${t("common.documentNoFailed")}：${(error as Error).message}`,
      );
      return;
    }
    setEditingReceipt(null);
    setFormWarehouseId(undefined);
    form.setFieldsValue({
      receipt_no: receiptNo,
      receipt_date: dayjs(new Date()),
      production_order_id: undefined,
      product_id: undefined,
      warehouse_id: undefined,
      location_id: undefined,
      quantity: 0,
      unit_cost: 0,
      amount: 0,
      batch_no: "",
      quality_status: "qualified",
      remark: "",
      status: DRAFT_STATUS,
    });
    setIsModalOpen(true);
  };

  // 选生产订单后顺手带出产品，并在下方提示该订单的计划量；
  // 刻意不自动填数量与仓库 —— 分次完工入库是常态，
  // 而生产订单上的 warehouse_id 是领料仓库，与完工入库仓不一定相同。
  const handleOrderChange = (orderId: number | undefined) => {
    if (!orderId) return;
    const order = orders.find((o) => o.id === orderId);
    if (order?.product_id && !form.getFieldValue("product_id")) {
      form.setFieldsValue({ product_id: order.product_id });
    }
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product ? `${product.code} - ${product.name}` : "-";
  };

  const getOrderLabel = (orderId: number | null) => {
    const order = orders.find((o) => o.id === orderId);
    return order?.order_no || "-";
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const warehouse = warehouses.find((w) => w.id === warehouseId);
    return warehouse?.name || "-";
  };

  const getBinLabel = (binId: number | null) => {
    if (!binId) return "-";
    const bin = bins.find((b) => b.id === binId);
    return bin ? `${bin.code} - ${bin.name}` : "-";
  };

  // 库位下拉只列当前仓库下的货位
  const formBinOptions = useMemo(
    () =>
      bins.filter(
        (b) =>
          formWarehouseId != null && b.warehouse_id === formWarehouseId,
      ),
    [bins, formWarehouseId],
  );

  const selectedOrder = orders.find(
    (o) => o.id === form.getFieldValue("production_order_id"),
  );

  const filteredReceipts = receipts.filter(
    (r) =>
      (r.receipt_no || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderLabel(r.production_order_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  // posted 只由过账动作产生，表单里不提供；approved / issued 保留用于渲染存量数据
  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.productionReceipts.statusDraft"), color: "default" },
    approved: {
      text: t("mrp.productionReceipts.statusApproved"),
      color: "blue",
    },
    issued: { text: t("mrp.productionReceipts.statusIssued"), color: "success" },
    posted: { text: t("mrp.productionReceipts.statusPosted"), color: "green" },
    cancelled: {
      text: t("mrp.productionReceipts.statusCancelled"),
      color: "error",
    },
  };

  const qualityLabels: Record<string, { text: string; color: string }> = {
    qualified: {
      text: t("mrp.productionReceipts.qualityQualified"),
      color: "green",
    },
    unqualified: {
      text: t("mrp.productionReceipts.qualityUnqualified"),
      color: "red",
    },
    pending: {
      text: t("mrp.productionReceipts.qualityPending"),
      color: "orange",
    },
  };

  const columns = [
    {
      title: t("mrp.productionReceipts.receiptNo"),
      dataIndex: "receipt_no",
      key: "receipt_no",
    },
    {
      title: t("mrp.productionReceipts.receiptDate"),
      dataIndex: "receipt_date",
      key: "receipt_date",
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.productionReceipts.productionOrder"),
      dataIndex: "production_order_id",
      key: "production_order_id",
      render: (orderId: number) => getOrderLabel(orderId),
    },
    {
      title: t("mrp.productionReceipts.product"),
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t("mrp.productionReceipts.warehouse"),
      dataIndex: "warehouse_id",
      key: "warehouse_id",
      render: (warehouseId: number) => getWarehouseName(warehouseId),
    },
    {
      title: t("mrp.productionReceipts.location"),
      dataIndex: "location_id",
      key: "location_id",
      render: (binId: number | null) => getBinLabel(binId),
    },
    {
      title: t("mrp.productionReceipts.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.productionReceipts.unitCost"),
      dataIndex: "unit_cost",
      key: "unit_cost",
      render: (cost: number) => formatMoney(cost),
    },
    {
      title: t("mrp.productionReceipts.amount"),
      dataIndex: "amount",
      key: "amount",
      render: (amount: number) => formatMoney(amount),
    },
    {
      title: t("mrp.productionReceipts.batchNo"),
      dataIndex: "batch_no",
      key: "batch_no",
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.productionReceipts.qualityStatus"),
      dataIndex: "quality_status",
      key: "quality_status",
      render: (status: string) => {
        const config = qualityLabels[status];
        // 回退原值，避免英文界面露出裸取值
        return config ? (
          <Tag color={config.color}>{config.text}</Tag>
        ) : (
          <Tag>{status || "-"}</Tag>
        );
      },
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: "default" };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t("mrp.productionReceipts.postedAt"),
      dataIndex: "posted_at",
      key: "posted_at",
      render: (text: string) => formatDateTime(text),
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: ProductionReceipt) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            disabled={isPosted(record)}
            onClick={() => handleEdit(record)}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            disabled={isPosted(record)}
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
        dataSource={filteredReceipts}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="production-receipts"
        headerTitle={t("mrp.productionReceipts.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.productionReceipts.add")}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t("mrp.productionReceipts.post")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={reversing}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t("mrp.productionReceipts.reverse")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.productionReceipts.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReceipts}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={
          editingReceipt
            ? t("mrp.productionReceipts.editTitle")
            : t("mrp.productionReceipts.addTitle")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReceipt(null);
          setFormWarehouseId(undefined);
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
        width={760}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReceipts.receiptNo")}
                name="receipt_no"
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReceipts.receiptNoPrompt"),
                  },
                ]}
              >
                <Input
                  placeholder={t("mrp.productionReceipts.receiptNoPrompt")}
                  disabled={!!editingReceipt}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReceipts.receiptDate")}
                name="receipt_date"
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReceipts.receiptDatePrompt"),
                  },
                ]}
              >
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReceipts.productionOrder")}
                name="production_order_id"
                extra={
                  selectedOrder
                    ? t("mrp.productionReceipts.plannedQuantityHint", {
                        quantity: formatQuantity(selectedOrder.planned_quantity),
                      })
                    : undefined
                }
              >
                <Select
                  placeholder={t("mrp.productionReceipts.productionOrderPrompt")}
                  allowClear
                  showSearch
                  optionFilterProp="children"
                  onChange={handleOrderChange}
                >
                  {orders.map((o) => (
                    <Option key={o.id} value={o.id}>
                      {o.order_no}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReceipts.product")}
                name="product_id"
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReceipts.productPrompt"),
                  },
                ]}
              >
                <Select
                  placeholder={t("mrp.productionReceipts.productPrompt")}
                  showSearch
                  optionFilterProp="children"
                >
                  {products.map((p) => (
                    <Option key={p.id} value={p.id}>
                      {p.code} - {p.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReceipts.warehouse")}
                name="warehouse_id"
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReceipts.warehousePrompt"),
                  },
                ]}
              >
                <Select
                  placeholder={t("mrp.productionReceipts.warehousePrompt")}
                  showSearch
                  optionFilterProp="children"
                  onChange={(value: number) => {
                    setFormWarehouseId(value);
                    // 换仓后原库位多半不属于新仓，直接清掉避免过账时校验失败
                    form.setFieldValue("location_id", undefined);
                  }}
                >
                  {warehouses.map((w) => (
                    <Option key={w.id} value={w.id}>
                      {w.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReceipts.location")}
                name="location_id"
                extra={t("mrp.productionReceipts.locationHint")}
              >
                <Select
                  allowClear
                  placeholder={t("mrp.productionReceipts.locationPrompt")}
                  disabled={formWarehouseId == null}
                  showSearch
                  optionFilterProp="children"
                >
                  {formBinOptions.map((b) => (
                    <Option key={b.id} value={b.id}>
                      {b.code} - {b.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReceipts.quantity")}
                name="quantity"
                initialValue={0}
                rules={[
                  {
                    required: true,
                    message: t("mrp.productionReceipts.quantityPrompt"),
                  },
                ]}
              >
                <InputNumber
                  min={0}
                  step={0.000001}
                  precision={6}
                  style={{ width: "100%" }}
                  placeholder={t("mrp.productionReceipts.quantityPrompt")}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReceipts.unitCost")}
                name="unit_cost"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                  placeholder={t("mrp.productionReceipts.unitCostPrompt")}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label={t("mrp.productionReceipts.batchNo")}
                name="batch_no"
              >
                <Input
                  placeholder={t("mrp.productionReceipts.batchNoPrompt")}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t("mrp.productionReceipts.qualityStatus")}
                name="quality_status"
                initialValue="qualified"
              >
                <Select>
                  {QUALITY_STATUSES.map((status) => (
                    <Option key={status} value={status}>
                      {qualityLabels[status].text}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("common.status")}
                name="status"
                initialValue={DRAFT_STATUS}
              >
                <Select>
                  <Option value={DRAFT_STATUS}>
                    {t("mrp.productionReceipts.statusDraft")}
                  </Option>
                  <Option value={CANCELLED_STATUS}>
                    {t("mrp.productionReceipts.statusCancelled")}
                  </Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>

          <Form.Item label={t("mrp.productionReceipts.remark")} name="remark">
            <Input.TextArea
              rows={3}
              placeholder={t("mrp.productionReceipts.remarkPrompt")}
            />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
