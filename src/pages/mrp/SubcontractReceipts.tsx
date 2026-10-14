import { useEffect, useState } from "react";
import type { Key } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Input,
  Table,
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
  Alert,
  Descriptions,
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
import {
  voucherNotice,
  type InventoryVoucherResult,
} from "../../utils/inventoryVoucher";
import { SuperTable } from "../../components/SuperTable";
import { useCurrencyRegistry } from "../../utils/money";
import { SupaModal } from "../../components/SupaModal";
import dayjs from "dayjs";

type SubcontractReceipt = Tables["erp_subcontract_receipts_s_539dcf81_b"]["Row"];
type SubcontractOrder = Tables["erp_subcontract_orders_s_539dcf81_b"]["Row"];
type SubcontractOrderDetail =
  Tables["erp_subcontract_order_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Supplier = Tables["erp_suppliers_s_539dcf81_b"]["Row"];
type Warehouse = Tables["erp_warehouses_s_539dcf81_b"]["Row"];
type Bin = Tables["erp_bins_s_539dcf81_b"]["Row"];

const { Option } = Select;
const receiptTable = "erp_subcontract_receipts_s_539dcf81_b";
const orderTable = "erp_subcontract_orders_s_539dcf81_b";
const orderDetailTable = "erp_subcontract_order_details_s_539dcf81_b";

// deploy_103：委外入库 = 成品入库 + 核销应发料 + 确认加工费
//   借 库存商品1405（材料成本 + 加工费）
//   贷 委托加工物资1408（材料成本）
//   贷 应付账款2202（加工费）
const POST_DOCUMENT_RPC = "post_subcontract_document";
const REVERSE_DOCUMENT_RPC = "reverse_subcontract_document";
const DOCUMENT_TYPE = "subcontract_receipt";
const POSTABLE_STATUSES = ["draft", "approved"];
const POSTED_STATUS = "posted";

const isPosted = (record: { status: string | null }) =>
  record.status === POSTED_STATUS;

const formatDateTime = (value: string | null | undefined) =>
  value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";

export function SubcontractReceipts() {
  const { t } = useTranslation();
  const { formatMoney, formatQuantity, currencyLabel, currencies } =
    useCurrencyRegistry();
  const [receipts, setReceipts] = useState<SubcontractReceipt[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [orders, setOrders] = useState<SubcontractOrder[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [orderDetails, setOrderDetails] = useState<SubcontractOrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<SubcontractReceipt | null>(
    null,
  );
  const [selectedReceipt, setSelectedReceipt] = useState<SubcontractReceipt | null>(
    null,
  );
  const [form] = Form.useForm();
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [headerWarehouseId, setHeaderWarehouseId] = useState<number | undefined>();

  useEffect(() => {
    fetchReceipts();
    fetchProducts();
    fetchSuppliers();
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
      console.error("Error fetching subcontract receipts:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    const { data } = await supabase
      .from("erp_products_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setProducts(data || []);
  };

  const fetchSuppliers = async () => {
    const { data } = await supabase
      .from("erp_suppliers_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setSuppliers(data || []);
  };

  const fetchOrders = async () => {
    const { data } = await supabase
      .from(orderTable)
      .select("*")
      .eq("is_deleted", "n");
    setOrders(data || []);
  };

  const fetchWarehouses = async () => {
    const { data } = await supabase
      .from("erp_warehouses_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setWarehouses(data || []);
  };

  const fetchBins = async () => {
    const { data } = await supabase
      .from("erp_bins_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setBins(data || []);
  };

  // 核销是「按订单应发料比例倒扣」，所以把应发料的已发/已核销摊给用户看，
  // 让他入库前就能判断这次能核销多少、会不会出现材料缺口。
  const fetchOrderDetails = async (orderId: number | null | undefined) => {
    if (!orderId) {
      setOrderDetails([]);
      return;
    }
    const { data } = await supabase
      .from(orderDetailTable)
      .select("*")
      .eq("is_deleted", "n")
      .eq("order_id", orderId)
      .order("line_no");
    setOrderDetails(data || []);
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload = {
        ...values,
        receipt_date: values.receipt_date
          ? dayjs(values.receipt_date).format("YYYY-MM-DD")
          : undefined,
        expiry_date: values.expiry_date
          ? dayjs(values.expiry_date).format("YYYY-MM-DD")
          : null,
      };
      if (editingReceipt) {
        await logWithTiming(
          t("mrp.subcontractReceipts.logUpdate"),
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
        const logParams: { table: string; recordId?: number } = {
          table: receiptTable,
        };
        const data = await logWithTiming(
          t("mrp.subcontractReceipts.logCreate"),
          "INSERT",
          async () => {
            const { data, error } = await supabase
              .from(receiptTable)
              .insert([payload])
              .select()
              .single();
            if (error) throw error;
            logParams.recordId = data.id;
            return data;
          },
          logParams,
        );
        setSelectedReceipt(data as SubcontractReceipt);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingReceipt(null);
      setHeaderWarehouseId(undefined);
      setOrderDetails([]);
      fetchReceipts();
    } catch (error) {
      console.error("Error saving subcontract receipt:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = async (record: SubcontractReceipt) => {
    if (isPosted(record)) {
      message.warning(t("mrp.subcontractReceipts.postedLocked"));
      return;
    }
    setEditingReceipt(record);
    setSelectedReceipt(record);
    setHeaderWarehouseId(record.warehouse_id ?? undefined);
    form.setFieldsValue({
      ...record,
      receipt_date: record.receipt_date ? dayjs(record.receipt_date) : undefined,
      expiry_date: record.expiry_date ? dayjs(record.expiry_date) : undefined,
    });
    await fetchOrderDetails(record.order_id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = receipts.find((row) => row.id === id);
    if (target && isPosted(target)) {
      message.warning(t("mrp.subcontractReceipts.postedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.subcontractReceipts.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            t("mrp.subcontractReceipts.logDelete"),
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
          console.error("Error deleting subcontract receipt:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const runSequential = async (
    targets: SubcontractReceipt[],
    action: (record: SubcontractReceipt) => Promise<void>,
    fallbackMessage: string,
  ) => {
    let success = 0;
    const failures: string[] = [];
    for (const record of targets) {
      try {
        await action(record);
        success += 1;
      } catch (error: any) {
        console.error("Error running subcontract receipt batch action:", error);
        failures.push(`${record.receipt_no}：${error?.message || fallbackMessage}`);
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
      message.warning(t("mrp.subcontractReceipts.postNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.subcontractReceipts.post"),
      content: t("mrp.subcontractReceipts.postConfirmContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setPosting(true);
        try {
          const notices: string[] = [];
          const { success, failures } = await runSequential(
            targets,
            async (record) => {
              const { data, error } = await supabase.rpc(POST_DOCUMENT_RPC, {
                p_document_type: DOCUMENT_TYPE,
                p_document_id: record.id,
                p_idempotency_key: crypto.randomUUID(),
              });
              if (error) throw error;
              const payload = data as {
                voucher?: InventoryVoucherResult;
                warnings?: Array<{ code: string; quantity?: number }>;
              } | null;
              const notice = voucherNotice(payload, t);
              if (notice) notices.push(`${record.receipt_no}：${notice}`);
              // 材料缺口 / 超收不阻断，但「收了货材料没跟着核销」必须提醒
              for (const warning of payload?.warnings || []) {
                notices.push(
                  `${record.receipt_no}：${t(
                    `mrp.subcontractReceipts.warn.${warning.code}`,
                    { qty: warning.quantity ?? "-", defaultValue: warning.code },
                  )}`,
                );
              }
            },
            t("mrp.subcontractReceipts.postFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.subcontractReceipts.postSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.subcontractReceipts.postPartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
          if (notices.length > 0) message.warning(notices.join("；"), 10);
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
      message.warning(t("mrp.subcontractReceipts.reverseNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.subcontractReceipts.reverse"),
      content: t("mrp.subcontractReceipts.reverseConfirmContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setReversing(true);
        try {
          const notices: string[] = [];
          const { success, failures } = await runSequential(
            targets,
            async (record) => {
              const { data, error } = await supabase.rpc(REVERSE_DOCUMENT_RPC, {
                p_document_type: DOCUMENT_TYPE,
                p_document_id: record.id,
                p_idempotency_key: crypto.randomUUID(),
              });
              if (error) throw error;
              const notice = voucherNotice(
                data as { voucher?: InventoryVoucherResult } | null,
                t,
              );
              if (notice) notices.push(`${record.receipt_no}：${notice}`);
            },
            t("mrp.subcontractReceipts.reverseFailed"),
          );
          if (failures.length === 0) {
            message.success(
              t("mrp.subcontractReceipts.reverseSuccessMany", { count: success }),
            );
          } else {
            message.error(
              t("mrp.subcontractReceipts.reversePartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
          if (notices.length > 0) message.warning(notices.join("；"), 10);
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
    setSelectedReceipt(null);
    setOrderDetails([]);
    setHeaderWarehouseId(undefined);
    form.setFieldsValue({
      receipt_no: receiptNo,
      receipt_date: dayjs(new Date()),
      supplier_id: undefined,
      order_id: undefined,
      product_id: undefined,
      quantity: 0,
      processing_fee: 0,
      currency: currencies.find((c) => c.isBase)?.code,
      exchange_rate: 1,
      warehouse_id: undefined,
      location_id: undefined,
      batch_no: "",
      expiry_date: undefined,
      status: "draft",
      remark: "",
    });
    setIsModalOpen(true);
  };

  const getProductLabel = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product ? `${product.code} - ${product.name}` : "-";
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || "-";
  };

  const getOrderNo = (orderId: number | null) => {
    if (!orderId) return "-";
    return orders.find((o) => o.id === orderId)?.order_no || "-";
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const warehouse = warehouses.find((w) => w.id === warehouseId);
    return warehouse?.name || "-";
  };

  // 订单成品与入库物料必须一致（过账会校验并抛 23514），这里提前把必然失败的选项挡掉
  const orderProductId = orders.find(
    (o) => o.id === form.getFieldValue("order_id"),
  )?.product_id;

  const filteredReceipts = receipts.filter(
    (row) =>
      row.receipt_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderNo(row.order_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductLabel(row.product_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.subcontractReceipts.statusDraft"), color: "default" },
    approved: { text: t("mrp.subcontractReceipts.statusApproved"), color: "blue" },
    posted: { text: t("mrp.subcontractReceipts.statusPosted"), color: "green" },
    cancelled: {
      text: t("mrp.subcontractReceipts.statusCancelled"),
      color: "error",
    },
  };

  const columns = [
    {
      title: t("mrp.subcontractReceipts.receiptNo"),
      dataIndex: "receipt_no",
      key: "receipt_no",
    },
    {
      title: t("mrp.subcontractReceipts.receiptDate"),
      dataIndex: "receipt_date",
      key: "receipt_date",
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.subcontractReceipts.supplier"),
      dataIndex: "supplier_id",
      key: "supplier_id",
      render: (id: number) => getSupplierName(id),
    },
    {
      title: t("mrp.subcontractReceipts.order"),
      dataIndex: "order_id",
      key: "order_id",
      render: (id: number) => getOrderNo(id),
    },
    {
      title: t("mrp.subcontractReceipts.product"),
      dataIndex: "product_id",
      key: "product_id",
      render: (id: number) => getProductLabel(id),
    },
    {
      title: t("mrp.subcontractReceipts.warehouse"),
      dataIndex: "warehouse_id",
      key: "warehouse_id",
      render: (id: number) => getWarehouseName(id),
    },
    {
      title: t("mrp.subcontractReceipts.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractReceipts.materialCost"),
      dataIndex: "material_cost",
      key: "material_cost",
      align: "right" as const,
      render: (amount: number, record: SubcontractReceipt) =>
        formatMoney(amount, record.currency),
    },
    {
      title: t("mrp.subcontractReceipts.processingFee"),
      dataIndex: "processing_fee",
      key: "processing_fee",
      align: "right" as const,
      render: (amount: number, record: SubcontractReceipt) =>
        formatMoney(amount, record.currency),
    },
    {
      title: t("mrp.subcontractReceipts.totalCost"),
      dataIndex: "total_cost",
      key: "total_cost",
      align: "right" as const,
      render: (amount: number, record: SubcontractReceipt) =>
        formatMoney(amount, record.currency),
    },
    {
      title: t("mrp.subcontractReceipts.unitCost"),
      dataIndex: "unit_cost",
      key: "unit_cost",
      align: "right" as const,
      render: (cost: number, record: SubcontractReceipt) =>
        formatMoney(cost, record.currency, { fallback: "-" }),
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
      title: t("mrp.subcontractReceipts.postedAt"),
      dataIndex: "posted_at",
      key: "posted_at",
      render: (text: string) => formatDateTime(text),
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: SubcontractReceipt) => (
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

  // 已核销明细（consumed_materials）——反过账就是按这份明细原样退回的，
  // 展示出来才能解释「为什么冲销后的已核销数量正好是这个数」。
  const consumedColumns = [
    {
      title: "#",
      key: "index",
      width: 50,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: t("mrp.subcontractReceipts.material"),
      dataIndex: "material_id",
      key: "material_id",
      render: (id: number) => getProductLabel(id),
    },
    {
      title: t("mrp.subcontractReceipts.consumedQuantity"),
      dataIndex: "quantity",
      key: "quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractReceipts.consumedUnitCost"),
      dataIndex: "unit_cost",
      key: "unit_cost",
      align: "right" as const,
      render: (cost: number) => formatMoney(cost),
    },
    {
      title: t("mrp.subcontractReceipts.consumedAmount"),
      dataIndex: "amount",
      key: "amount",
      align: "right" as const,
      render: (amount: number) => formatMoney(amount),
    },
  ];

  const consumedRows = Array.isArray(selectedReceipt?.consumed_materials)
    ? selectedReceipt!.consumed_materials
    : [];
  const consumedTotal = consumedRows.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );

  const detailBinOptions = bins.filter(
    (b) => headerWarehouseId != null && b.warehouse_id === headerWarehouseId,
  );

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredReceipts}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="subcontract-receipts"
        headerTitle={t("mrp.subcontractReceipts.title")}
        toolbarActions={["export"]}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.subcontractReceipts.add")}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t("mrp.subcontractReceipts.post")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={reversing}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t("mrp.subcontractReceipts.reverse")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.subcontractReceipts.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReceipts}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={
          editingReceipt
            ? t("mrp.subcontractReceipts.editTitle")
            : t("mrp.subcontractReceipts.addTitle")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReceipt(null);
          setSelectedReceipt(null);
        }}
        headerPanelTitle={t("mrp.subcontractReceipts.headerPanelTitle")}
        detailPanelTitle={t("mrp.subcontractReceipts.detailPanelTitle")}
        historyTable={receiptTable}
        historyRecordId={editingReceipt?.id || selectedReceipt?.id}
        form={form}
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.subcontractReceipts.receiptNo")}
                  name="receipt_no"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractReceipts.receiptNoPrompt"),
                    },
                  ]}
                >
                  <Input disabled={!!editingReceipt} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractReceipts.receiptDate")}
                  name="receipt_date"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractReceipts.receiptDatePrompt"),
                    },
                  ]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractReceipts.supplier")}
                  name="supplier_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractReceipts.supplierPrompt"),
                    },
                  ]}
                >
                  <Select showSearch optionFilterProp="children">
                    {suppliers.map((s) => (
                      <Option key={s.id} value={s.id}>
                        {s.code} - {s.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractReceipts.order")}
                  name="order_id"
                  extra={t("mrp.subcontractReceipts.orderHint")}
                >
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="children"
                    onChange={(value: number | undefined) => {
                      fetchOrderDetails(value);
                      const picked = orders.find((o) => o.id === value);
                      if (picked) {
                        form.setFieldsValue({
                          product_id: picked.product_id,
                          warehouse_id: picked.warehouse_id ?? undefined,
                        });
                        setHeaderWarehouseId(picked.warehouse_id ?? undefined);
                      }
                    }}
                  >
                    {orders.map((o) => (
                      <Option key={o.id} value={o.id}>
                        {o.order_no}（{getProductLabel(o.product_id)}）
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractReceipts.product")}
                  name="product_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractReceipts.productPrompt"),
                    },
                  ]}
                >
                  <Select showSearch optionFilterProp="children">
                    {(orderProductId
                      ? products.filter((p) => p.id === orderProductId)
                      : products
                    ).map((p) => (
                      <Option key={p.id} value={p.id}>
                        {p.code} - {p.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractReceipts.remark")}
                  name="remark"
                >
                  <Input.TextArea rows={2} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.subcontractReceipts.quantity")}
                  name="quantity"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractReceipts.quantityPrompt"),
                    },
                  ]}
                >
                  <InputNumber
                    min={0}
                    step={0.000001}
                    precision={6}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractReceipts.processingFee")}
                  name="processing_fee"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractReceipts.processingFeePrompt"),
                    },
                  ]}
                  extra={t("mrp.subcontractReceipts.processingFeeHint")}
                >
                  <InputNumber
                    min={0}
                    step={0.01}
                    precision={2}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Row gutter={8}>
                  <Col span={14}>
                    <Form.Item
                      label={t("mrp.subcontractReceipts.currency")}
                      name="currency"
                    >
                      <Select>
                        {currencies.map((c) => (
                          <Option key={c.code} value={c.code}>
                            {currencyLabel(c.code, c.name)}
                          </Option>
                        ))}
                      </Select>
                    </Form.Item>
                  </Col>
                  <Col span={10}>
                    <Form.Item
                      label={t("mrp.subcontractReceipts.exchangeRate")}
                      name="exchange_rate"
                    >
                      <InputNumber
                        min={0}
                        step={0.00000001}
                        precision={8}
                        style={{ width: "100%" }}
                      />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item
                  label={t("mrp.subcontractReceipts.warehouse")}
                  name="warehouse_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractReceipts.warehousePrompt"),
                    },
                  ]}
                >
                  <Select
                    showSearch
                    optionFilterProp="children"
                    onChange={(value: number) => setHeaderWarehouseId(value)}
                  >
                    {warehouses.map((w) => (
                      <Option key={w.id} value={w.id}>
                        {w.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Row gutter={8}>
                  <Col span={12}>
                    <Form.Item
                      label={t("mrp.subcontractReceipts.location")}
                      name="location_id"
                    >
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="children"
                        disabled={
                          detailBinOptions.length === 0 &&
                          headerWarehouseId == null
                        }
                      >
                        {detailBinOptions.map((b) => (
                          <Option key={b.id} value={b.id}>
                            {b.code} - {b.name}
                          </Option>
                        ))}
                      </Select>
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label={t("mrp.subcontractReceipts.batchNo")}
                      name="batch_no"
                    >
                      <Input />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={8}>
                  <Col span={12}>
                    <Form.Item
                      label={t("mrp.subcontractReceipts.expiryDate")}
                      name="expiry_date"
                    >
                      <DatePicker style={{ width: "100%" }} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label={t("common.status")}
                      name="status"
                      initialValue="draft"
                    >
                      <Select>
                        <Option value="draft">
                          {t("mrp.subcontractReceipts.statusDraft")}
                        </Option>
                        <Option value="approved">
                          {t("mrp.subcontractReceipts.statusApproved")}
                        </Option>
                        <Option value="cancelled">
                          {t("mrp.subcontractReceipts.statusCancelled")}
                        </Option>
                      </Select>
                    </Form.Item>
                  </Col>
                </Row>                
              </Col>
            </Row>
          </Form>
        }
        tableEle={
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            {selectedReceipt && isPosted(selectedReceipt) && (
              <Alert
                type="success"
                showIcon
                message={t("mrp.subcontractReceipts.postedSummary")}
                description={
                  <Descriptions size="small" column={4}>
                    <Descriptions.Item
                      label={t("mrp.subcontractReceipts.materialCost")}
                    >
                      {formatMoney(
                        selectedReceipt.material_cost,
                        selectedReceipt.currency,
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item
                      label={t("mrp.subcontractReceipts.processingFee")}
                    >
                      {formatMoney(
                        selectedReceipt.processing_fee,
                        selectedReceipt.currency,
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item
                      label={t("mrp.subcontractReceipts.totalCost")}
                    >
                      {formatMoney(
                        selectedReceipt.total_cost,
                        selectedReceipt.currency,
                      )}
                    </Descriptions.Item>
                    <Descriptions.Item
                      label={t("mrp.subcontractReceipts.unitCost")}
                    >
                      {formatMoney(
                        selectedReceipt.unit_cost,
                        selectedReceipt.currency,
                      )}
                    </Descriptions.Item>
                  </Descriptions>
                }
              />
            )}

            <Table
              columns={consumedColumns}
              dataSource={consumedRows}
              rowKey={(row: any, index?: number) =>
                `${row.order_detail_id ?? "x"}-${index ?? 0}`
              }
              pagination={false}
              size="small"
              title={() => t("mrp.subcontractReceipts.consumedTitle")}
              locale={{ emptyText: t("mrp.subcontractReceipts.consumedEmpty") }}
              summary={() =>
                consumedRows.length > 0 ? (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={4} align="right">
                      <strong>{t("mrp.subcontractReceipts.totalText")}</strong>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={4} align="right">
                      <strong>{formatMoney(consumedTotal)}</strong>
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                ) : null
              }
            />

            {!isPosted(selectedReceipt || ({} as SubcontractReceipt)) && (
              <Table
                columns={[
                  { title: "#", dataIndex: "line_no", key: "line_no", width: 60 },
                  {
                    title: t("mrp.subcontractReceipts.material"),
                    dataIndex: "material_id",
                    key: "material_id",
                    render: (id: number) => getProductLabel(id),
                  },
                  {
                    title: t("mrp.subcontractReceipts.requiredQuantity"),
                    dataIndex: "required_quantity",
                    key: "required_quantity",
                    align: "right" as const,
                    render: (qty: number) => formatQuantity(qty),
                  },
                  {
                    title: t("mrp.subcontractReceipts.issuedQuantity"),
                    dataIndex: "issued_quantity",
                    key: "issued_quantity",
                    align: "right" as const,
                    render: (qty: number) => formatQuantity(qty),
                  },
                  {
                    title: t("mrp.subcontractReceipts.consumedQuantity"),
                    dataIndex: "consumed_quantity",
                    key: "consumed_quantity",
                    align: "right" as const,
                    render: (qty: number) => formatQuantity(qty),
                  },
                  {
                    title: t("mrp.subcontractReceipts.remaining"),
                    key: "remaining",
                    align: "right" as const,
                    render: (_: any, row: SubcontractOrderDetail) =>
                      formatQuantity(
                        Number(row.required_quantity || 0) -
                          Number(row.consumed_quantity || 0),
                      ),
                  },
                ]}
                dataSource={orderDetails}
                rowKey="id"
                pagination={false}
                size="small"
                title={() => t("mrp.subcontractReceipts.orderDetailTitle")}
                locale={{ emptyText: t("mrp.subcontractReceipts.orderDetailEmpty") }}
              />
            )}
          </Space>
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="primary"
              onClick={() => form.submit()}
              disabled={!!editingReceipt && isPosted(editingReceipt)}
            >
              {t("common.save")}
            </Button>
          </Space>
        }
        width={"82%"}
        height={"84%"}
      />
    </div>
  );
}
