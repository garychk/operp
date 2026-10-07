import { useEffect, useMemo, useState } from "react";
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
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ShoppingCartOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import { SupaModal } from "../../components/SupaModal";
import { BizAttachments } from "../../components/BizAttachments";
import { SuperTable } from "../../components/SuperTable";
import {
  formatMoney,
  useCurrencyRegistry,
  currencyLabel,
  fetchExchangeRate,
} from "../../utils/money";
import { ProductUnit } from "../../components/ProductUnit";
import dayjs from "dayjs";
import SimpleModal from "../../components/SimpleModal";

type PurchaseOrder = Tables["erp_purchase_orders_s_539dcf81_b"]["Row"];
type PurchaseOrderDetail =
  Tables["erp_purchase_order_details_s_539dcf81_b"]["Row"];
type Supplier = Tables["erp_suppliers_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];

const { Option } = Select;
const { TextArea } = Input;
const purchaseOrderTable = "erp_purchase_orders_s_539dcf81_b";
const purchaseOrderDetailTable = "erp_purchase_order_details_s_539dcf81_b";
const docType = "purchase_order";

/** 金额/单价四舍五入到本位币精度（与后端 NUMERIC(18,2) / (18,4) 对齐） */
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;

export function PurchaseOrders() {
  const { t } = useTranslation();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<PurchaseOrder | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<PurchaseOrder | null>(
    null,
  );
  const [details, setDetails] = useState<PurchaseOrderDetail[]>([]);
  const [editingDetail, setEditingDetail] =
    useState<PurchaseOrderDetail | null>(null);
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();

  // 明细行金额跟随表头币种（新单据取表单当前值，编辑时取单据值）
  // 币别元数据与当前租户本位币（来自 erp_currencies / current_base_currency()）
  const { baseCurrency, currencies } = useCurrencyRegistry();

  const watchedCurrency = Form.useWatch("currency", form);
  const watchedRate = Form.useWatch("exchange_rate", form);
  const detailCurrency = watchedCurrency ?? editingOrder?.currency ?? undefined;
  const baseCurrencyCode = (baseCurrency || "CNY").toUpperCase();
  const isForeignCurrency =
    !!detailCurrency && detailCurrency.toUpperCase() !== baseCurrencyCode;

  // 冻结汇率：外币取表单值，本位币恒为 1
  const activeRate = isForeignCurrency
    ? Number(watchedRate ?? editingOrder?.exchange_rate ?? 0) || 0
    : 1;

  // 币种选项：只列启用中的币别；当前单据已选的币别即使已停用也要保留，
  // 否则编辑历史单据时下拉会显示空白（值在、选项没了）。
  const currencyOptions = useMemo(() => {
    const selected = (detailCurrency || "").toUpperCase();
    return currencies
      .filter((c) => c.status === "active" || c.code.toUpperCase() === selected)
      .map((c) => ({
        value: c.code,
        label: `${c.code} · ${currencyLabel(c.code, c.name)}`,
      }));
  }, [currencies, detailCurrency]);

  /**
   * 切换币种时预填汇率：取该币种在单据日期上的即期汇率。
   * 拿不到就清空并提示 —— 不隐式按 1 处理（外币金额当人民币入账是静默错误）。
   */
  const handleCurrencyChange = async (code: string) => {
    if (!code || code.toUpperCase() === baseCurrencyCode) {
      form.setFieldValue("exchange_rate", 1);
      return;
    }
    const orderDate = form.getFieldValue("order_date");
    const dateText = orderDate ? dayjs(orderDate).format("YYYY-MM-DD") : undefined;
    const rate = await fetchExchangeRate(code, dateText);
    if (rate !== null) {
      form.setFieldValue("exchange_rate", rate);
      message.info(t("currency.rateAutoFilled", { date: dateText ?? "-" }));
    } else {
      form.setFieldValue("exchange_rate", undefined);
      message.warning(t("currency.rateMissing", { code, date: dateText ?? "-" }));
    }
  };
  const [isDisabled, setIsDisabled] = useState(false);

  useEffect(() => {
    fetchOrders();
    fetchSuppliers();
    fetchProducts();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("erp_purchase_orders_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("order_date", { ascending: false });

      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Error fetching orders:", error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_suppliers_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("status", "active");
      if (error) throw error;
      setSuppliers(data || []);
    } catch (error) {
      console.error("Error fetching suppliers:", error);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("status", "active");
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
    }
  };

  const fetchDetails = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_purchase_order_details_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("order_id", orderId)
        .order("line_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching details:", error);
      message.error(t('purchaseOrders.fetchDetailsFailed'));
    }
  };

  const calculateOrderTotals = (
    detailRows: PurchaseOrderDetail[],
    exchangeRate = 1,
  ) => {
    const totalAmount = detailRows.reduce((sum, d) => sum + (d.amount || 0), 0);
    const taxAmount = detailRows.reduce(
      (sum, d) => sum + (d.tax_amount || 0),
      0,
    );
    const rate = exchangeRate > 0 ? exchangeRate : 1;
    return {
      total_amount: totalAmount,
      tax_amount: taxAmount,
      payable_amount: totalAmount + taxAmount,
      // 双金额：本位币金额按单据上冻结的汇率折算
      base_total_amount: round2(totalAmount * rate),
      base_tax_amount: round2(taxAmount * rate),
    };
  };

  const handleSubmit = async (values: any) => {
    try {
      // 币种与汇率落定：本位币强制汇率 = 1；外币必须带正汇率（表单已校验，这里兜底）
      const currencyCode = (values.currency || baseCurrencyCode).toUpperCase();
      const formRate =
        currencyCode === baseCurrencyCode ? 1 : Number(values.exchange_rate) || 0;
      if (currencyCode !== baseCurrencyCode && formRate <= 0) {
        message.error(t("currency.form.rateRequired"));
        return;
      }

      const orderTotals = calculateOrderTotals(details, formRate);
      const payload = {
        ...values,
        currency: currencyCode,
        exchange_rate: formRate,
        ...orderTotals,
      };

      if (editingOrder) {
        await logWithTiming(
          t('purchaseOrders.log.updateAction'),
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(purchaseOrderTable)
              .update(payload)
              .eq("id", editingOrder.id);
            if (error) throw error;
          },
          { table: purchaseOrderTable, recordId: editingOrder.id },
        );
        message.success(t('common.updateSuccess'));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: purchaseOrderTable,
        };
        const data = await logWithTiming(
          t('purchaseOrders.log.createAction'),
          "INSERT",
          async () => {
            const { data, error } = await supabase
              .from(purchaseOrderTable)
              .insert([payload])
              .select()
              .single();
            if (error) throw error;
            logParams.recordId = data.id;
            return data;
          },
          logParams,
        );
        setSelectedOrder(data);
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingOrder(null);
      fetchOrders();
    } catch (error) {
      console.error("Error saving order:", error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedOrder) {
        message.error(t('purchaseOrders.selectOrderFirst'));
        return;
      }

      values.amount = (values.quantity || 0) * (values.unit_price || 0);
      values.tax_amount = values.amount * ((values.tax_rate || 0) / 100);
      // 明细行双金额：逐行按冻结汇率折本位币（行级四舍五入，差额由表头吸收）
      values.base_unit_price = round4((values.unit_price || 0) * activeRate);
      values.base_amount = round2(values.amount * activeRate);

      if (editingDetail) {
        await supabase
          .from("erp_purchase_order_details_s_539dcf81_b")
          .update(values)
          .eq("id", editingDetail.id);
        message.success(t('common.updateSuccess'));
      } else {
        const maxLineNo =
          details.length > 0 ? Math.max(...details.map((d) => d.line_no)) : 0;
        values.line_no = maxLineNo + 1;
        values.order_id = selectedOrder.id;
        values.received_quantity = 0;
        values.is_deleted = "n";

        console.log("Inserting detail with values:", values);
        const { data, error } = await supabase
          .from("erp_purchase_order_details_s_539dcf81_b")
          .insert([values]);
        console.log("Insert result:", data, error);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedOrder.id);
      updateOrderTotal(selectedOrder.id);
    } catch (error) {
      console.error("Error saving detail:", error);
      message.error(t('common.saveFailed'));
    }
  };

  const updateOrderTotal = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_purchase_order_details_s_539dcf81_b")
        .select("amount, tax_amount")
        .eq("is_deleted", "n")
        .eq("order_id", orderId);
      if (error) throw error;

      const totalAmount =
        data?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;
      const taxAmount =
        data?.reduce((sum, d) => sum + (d.tax_amount || 0), 0) || 0;

      // 用**单据自己冻结的汇率**折算，而不是表单当前的 activeRate ——
      // 本函数在明细弹窗关闭后调用，此时表单可能已被重置。
      const order = orders.find((o) => o.id === orderId);
      const orderCurrency = (order?.currency || baseCurrencyCode).toUpperCase();
      const orderRate =
        orderCurrency === baseCurrencyCode ? 1 : Number(order?.exchange_rate) || 1;

      await supabase
        .from("erp_purchase_orders_s_539dcf81_b")
        .update({
          total_amount: totalAmount,
          tax_amount: taxAmount,
          payable_amount: totalAmount + taxAmount,
          base_total_amount: round2(totalAmount * orderRate),
          base_tax_amount: round2(taxAmount * orderRate),
          base_discount_amount: round2((order?.discount_amount || 0) * orderRate),
        })
        .eq("id", orderId);

      fetchOrders();
    } catch (error) {
      console.error("Error updating order total:", error);
    }
  };

  const handleEdit = async (record: PurchaseOrder) => {
    setEditingOrder(record);
    setIsDisabled(
      ["approved", "partially_received", "received", "closed"].includes(
        record.status || "",
      ),
    );
    const formValues = { ...record };
    if (formValues.order_date) {
      formValues.order_date = dayjs(formValues.order_date);
    }
    if (formValues.delivery_date) {
      formValues.delivery_date = dayjs(formValues.delivery_date);
    }
    form.setFieldsValue(formValues);
    setSelectedOrder(record);
    await fetchDetails(record.id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('purchaseOrders.deleteOrderConfirm'),
      onOk: async () => {
        try {
          await logWithTiming(
            t('purchaseOrders.log.deleteAction'),
            "DELETE",
            async () => {
              const { error } = await supabase
                .from("erp_purchase_orders_s_539dcf81_b")
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
              const { error: detailError } = await supabase
                .from(purchaseOrderDetailTable)
                .update({ is_deleted: "y" })
                .eq("order_id", id);
              if (detailError) throw detailError;
            },
            { table: purchaseOrderTable, recordId: id },
          );
          message.success(t('common.deleteSuccess'));
          fetchOrders();
        } catch (error) {
          console.error("Error deleting order:", error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = async () => {
    let orderNo: string;
    try {
      orderNo = await nextDocumentNo(docType);
    } catch (error) {
      message.error(`${t("common.documentNoFailed")}：${(error as Error).message}`);
      return;
    }
    setEditingOrder(null);
    setSelectedOrder(null);
    setIsDisabled(false);
    form.setFieldsValue({
      order_no: orderNo,
      order_date: dayjs(new Date()),
      supplier_id: undefined,
      delivery_date: "",
      total_amount: 0,
      tax_amount: 0,
      payable_amount: 0,
      base_total_amount: 0,
      base_tax_amount: 0,
      base_discount_amount: 0,
      currency: baseCurrencyCode,
      exchange_rate: 1,
      delivery_address: "",
      contact_person: "",
      contact_phone: "",
      remark: "",
      status: "draft",
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingDetail(null);
    detailForm.setFieldsValue({
      product_id: undefined,
      quantity: 1,
      unit_price: 0,
      amount: 0,
      tax_rate: 13,
      tax_amount: 0,
      remark: "",
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: PurchaseOrderDetail) => {
    setEditingDetail(record);
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('purchaseOrders.deleteDetailConfirm'),
      onOk: async () => {
        try {
          await supabase
            .from("erp_purchase_order_details_s_539dcf81_b")
            .update({ is_deleted: "y" })
            .eq("id", id);
          message.success(t('common.deleteSuccess'));
          if (selectedOrder) {
            fetchDetails(selectedOrder.id);
            updateOrderTotal(selectedOrder.id);
          }
        } catch (error) {
          console.error("Error deleting detail:", error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || "-";
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || "-";
  };

  const getProductPrice = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.purchase_price || 0;
  };

  const filteredOrders = orders.filter(
    (order) =>
      (order.order_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
        getSupplierName(order.supplier_id)
          .toLowerCase()
          .includes(searchTerm.toLowerCase())) &&
      (!statusFilter || order.status === statusFilter),
  );

  const statusLabels: Record<string, { textKey: string; color: string }> = {
    draft: {
      textKey: "purchaseOrders.statusOptions.draft",
      color: "default",
    },
    pending: {
      textKey: "purchaseOrders.statusOptions.pending",
      color: "warning",
    },
    approved: {
      textKey: "purchaseOrders.statusOptions.approved",
      color: "success",
    },
    partially_received: {
      textKey: "purchaseOrders.statusOptions.partiallyReceived",
      color: "processing",
    },
    received: {
      textKey: "purchaseOrders.statusOptions.received",
      color: "success",
    },
    closed: {
      textKey: "purchaseOrders.statusOptions.closed",
      color: "default",
    },
    cancelled: {
      textKey: "purchaseOrders.statusOptions.cancelled",
      color: "error",
    },
  };

  const columns = [
    {
      title: t('purchaseOrders.orderNo'),
      dataIndex: "order_no",
      key: "order_no",
      width: 150,
    },
    {
      title: t('purchaseOrders.supplier'),
      dataIndex: "supplier_id",
      key: "supplier_id",
      render: (supplierId: number) => getSupplierName(supplierId),
    },
    {
      title: t('purchaseOrders.orderDate'),
      dataIndex: "order_date",
      key: "order_date",
      width: 130,
    },
    {
      title: t('purchaseOrders.deliveryDate'),
      dataIndex: "delivery_date",
      key: "delivery_date",
      width: 130,
      render: (text: string) => text || "-",
    },
    {
      title: t('purchaseOrders.currency'),
      dataIndex: "currency",
      key: "currency",
      width: 110,
      render: (code: string) => (code ? `${code} · ${currencyLabel(code)}` : "-"),
    },
    {
      title: t('purchaseOrders.amount'),
      dataIndex: "total_amount",
      key: "total_amount",
      width: 130,
      render: (amount: number, record: PurchaseOrder) => formatMoney(amount, record.currency),
    },
    {
      title: t('currency.field.baseAmount'),
      dataIndex: "base_total_amount",
      key: "base_total_amount",
      width: 130,
      render: (amount: number) => formatMoney(amount, baseCurrencyCode),
    },
    {
      title: t('purchaseOrders.payableAmount'),
      dataIndex: "payable_amount",
      key: "payable_amount",
      width: 130,
      render: (amount: number, record: PurchaseOrder) => formatMoney(amount, record.currency),
    },
    {
      title: t('common.status'),
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (status: string) => {
        const config = statusLabels[status] || {
          textKey: status,
          color: "default",
        };
        return <Tag color={config.color}>{t(config.textKey)}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: "action",
      width: 160,
      defaultFixed: "right" as const,
      lockWidth: true,
      render: (_: any, record: PurchaseOrder) => (
        <Space size="small">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id)}
            disabled={record.status !== "draft"}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    {
      title: t('purchaseOrders.lineNo'),
      dataIndex: "line_no",
      key: "line_no",
    },
    {
      title: t('purchaseOrders.product'),
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t('purchaseOrders.unit'),
      dataIndex: "product_id",
      key: "unit",
      render: (productId: number) => (
        <ProductUnit productId={productId} usageType="purchase" />
      ),
    },
    {
      title: t('purchaseOrders.quantity'),
      dataIndex: "quantity",
      key: "quantity",
      render: (qty: number) => qty?.toLocaleString() || "0",
    },
    {
      title: t('purchaseOrders.unitPrice'),
      dataIndex: "unit_price",
      key: "unit_price",
      render: (price: number) => formatMoney(price, detailCurrency),
    },
    {
      title: t('purchaseOrders.amount'),
      dataIndex: "amount",
      key: "amount",
      render: (amount: number) => formatMoney(amount, detailCurrency),
    },
    {
      title: t('purchaseOrders.taxRate'),
      dataIndex: "tax_rate",
      key: "tax_rate",
      render: (rate: number) => rate || "0",
    },
    {
      title: t('purchaseOrders.taxAmount'),
      dataIndex: "tax_amount",
      key: "tax_amount",
      render: (amount: number) => formatMoney(amount, detailCurrency),
    },
    {
      title: t('purchaseOrders.receivedQuantity'),
      dataIndex: "received_quantity",
      key: "received_quantity",
      render: (qty: number) => qty?.toLocaleString() || "0",
    },
    {
      title: t('purchaseOrders.remainingQuantity'),
      key: "remaining_quantity",
      render: (_: any, record: PurchaseOrderDetail) => {
        const remaining = Math.max(
          0,
          (record.quantity || 0) - (record.received_quantity || 0),
        );
        return remaining.toLocaleString();
      },
    },
    {
      title: t('common.actions'),
      key: "action",
      render: (_: any, record: PurchaseOrderDetail) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEditDetail(record)}
            disabled={isDisabled}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDeleteDetail(record.id)}
            disabled={isDisabled}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailTotal = details.reduce(
    (acc, d) => ({
      amount: acc.amount + (d.amount || 0),
      taxAmount: acc.taxAmount + (d.tax_amount || 0),
    }),
    { amount: 0, taxAmount: 0 },
  );

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredOrders}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey={docType}
        headerTitle={t('purchaseOrders.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t('purchaseOrders.addOrder')}
            </Button>
            <Input.Search
              allowClear
              placeholder={t('purchaseOrders.searchPlaceholder')}
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onSearch={fetchOrders}
              style={{ width: 240 }}
            />
            <Select
              allowClear
              placeholder={t('purchaseOrders.allStatus')}
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 140 }}
              options={Object.entries(statusLabels).map(([value, item]) => ({
                value,
                label: t(item.textKey),
              }))}
            />
          </Space>
        }
      />
      <SupaModal
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingOrder(null);
          setSelectedOrder(null);
        }}
        title={
          <>
            <ShoppingCartOutlined />
            <span>
              {editingOrder
                ? t('purchaseOrders.editOrderTitle')
                : t('purchaseOrders.addOrderTitle')}
            </span>
          </>
        }
        headerExtra={
          <Tag color={editingOrder?.status === "draft" ? "blue" : "green"}>
            {editingOrder?.status === "draft"
              ? t('purchaseOrders.statusOptions.draft')
              : t('purchaseOrders.statusReviewed')}
          </Tag>
        }
        headerPanelTitle={t('purchaseOrders.headerPanelTitle')}
        detailPanelTitle={t('purchaseOrders.detailPanelTitle')}
        historyTable={purchaseOrderTable}
        historyRecordId={editingOrder?.id || selectedOrder?.id}
        detailItems={[
          {
            key: "attachments",
            label: t("attachments.title"),
            disabled: !(editingOrder?.id || selectedOrder?.id),
            children: (
              <BizAttachments
                bizType="purchase_order"
                bizId={editingOrder?.id || selectedOrder?.id}
              />
            ),
          },
        ]}
        onDataChanged={() => {
          fetchOrders();
          if (selectedOrder) fetchDetails(selectedOrder.id);
        }}
        detailExtra={
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleAddDetail}
            disabled={isDisabled}
          >
            {t('purchaseOrders.addDetail')}
          </Button>
        }
        form={form}
        workflowDocumentType={docType}
        documentNo={editingOrder?.order_no}
        docFlowUsageType="purchase"
        detailData={details}
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('purchaseOrders.orderNo')}
                  name="order_no"
                  rules={[{ required: true, message: t('purchaseOrders.orderNoRequired') }]}
                >
                  <Input
                    placeholder={t('purchaseOrders.orderNoPlaceholder')}
                    disabled={!!editingOrder}
                  />
                </Form.Item>
                <Form.Item
                  label={t('purchaseOrders.supplier')}
                  name="supplier_id"
                  rules={[{ required: true, message: t('purchaseOrders.supplierRequired') }]}
                >
                  <Select placeholder={t('purchaseOrders.supplierPlaceholder')}>
                    {suppliers.map((s) => (
                      <Option key={s.id} value={s.id}>
                        {s.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t('purchaseOrders.orderDate')}
                  name="order_date"
                  rules={[{ required: true, message: t('purchaseOrders.orderDateRequired') }]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t('purchaseOrders.deliveryDate')}
                  name="delivery_date"
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t('purchaseOrders.totalAmount')}
                  name="total_amount"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t('purchaseOrders.totalAmountPlaceholder')}
                  />
                </Form.Item>
                <Form.Item
                  label={t('purchaseOrders.taxAmount')}
                  name="tax_amount"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t('purchaseOrders.taxAmountPlaceholder')}
                  />
                </Form.Item>
                <Form.Item
                  label={t('purchaseOrders.payableAmount')}
                  name="payable_amount"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t('purchaseOrders.payableAmountPlaceholder')}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t('purchaseOrders.currency')}
                  name="currency"
                  rules={[{ required: true, message: t("currency.form.currencyRequired") }]}
                >
                  <Select
                    options={currencyOptions}
                    onChange={(code: string) => void handleCurrencyChange(code)}
                  />
                </Form.Item>
                {isForeignCurrency && (
                  <Form.Item
                    label={t('currency.field.exchangeRate')}
                    name="exchange_rate"
                    tooltip={t('currency.rateTooltip')}
                    rules={[
                      { required: true, message: t('currency.form.rateRequired') },
                      {
                        type: "number",
                        min: 0.00000001,
                        message: t('currency.form.ratePositive'),
                      },
                    ]}
                    extra={t('currency.frozenHint')}
                  >
                    <InputNumber
                      style={{ width: "100%" }}
                      precision={8}
                      min={0}
                      addonAfter={baseCurrencyCode}
                    />
                  </Form.Item>
                )}
                <Form.Item
                  label={t('purchaseOrders.deliveryAddress')}
                  name="delivery_address"
                >
                  <Input
                    placeholder={t('purchaseOrders.deliveryAddressPlaceholder')}
                  />
                </Form.Item>
                <Form.Item
                  label={t('purchaseOrders.contactPerson')}
                  name="contact_person"
                >
                  <Input
                    placeholder={t('purchaseOrders.contactPersonPlaceholder')}
                  />
                </Form.Item>
                <Form.Item
                  label={t('purchaseOrders.contactPhone')}
                  name="contact_phone"
                >
                  <Input
                    placeholder={t('purchaseOrders.contactPhonePlaceholder')}
                  />
                </Form.Item>
                <Form.Item label={t('purchaseOrders.remark')} name="remark">
                  <TextArea
                    rows={5}
                    placeholder={t('purchaseOrders.remarkPlaceholder')}
                  />
                </Form.Item>
                <Form.Item
                  label={t('common.status')}
                  name="status"
                  initialValue="draft"
                >
                  <Select disabled>
                    {Object.entries(statusLabels).map(([value, item]) => (
                      <Option key={value} value={value}>
                        {t(item.textKey)}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={5} align="right">
                  <strong>{t('purchaseOrders.total')}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="left">
                  <strong>{formatMoney(detailTotal.amount, detailCurrency)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2}></Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="left">
                  <strong>{formatMoney(detailTotal.taxAmount, detailCurrency)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} colSpan={3}></Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="primary"
              onClick={() => form.submit()}
              disabled={isDisabled}
            >
              {t('common.save')}
            </Button>
          </Space>
        }
        width={'80%'}
        height={'80%'}
      />
      <SimpleModal
        title={
          editingDetail
            ? t('purchaseOrders.editDetailTitle')
            : t('purchaseOrders.addDetailTitle')
        }
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsDetailModalOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="primary" onClick={() => detailForm.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width={500}
        height={500}
      >
        <Form
          form={detailForm}
          layout="vertical"
          onFinish={handleDetailSubmit}
          style={{ marginRight: 16 }}
        >
          <Form.Item
            label={t('purchaseOrders.product')}
            name="product_id"
            rules={[{ required: true, message: t('purchaseOrders.productRequired') }]}
          >
            <Select
              placeholder={t('purchaseOrders.productPlaceholder')}
              onChange={(value) => {
                const price = getProductPrice(value as number);
                detailForm.setFieldsValue({ unit_price: price });
              }}
            >
              {products.map((p) => (
                <Option key={p.id} value={p.id}>
                  {p.code} - {p.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('purchaseOrders.quantity')}
                name="quantity"
                rules={[{ required: true, message: t('purchaseOrders.quantityRequired') }]}
              >
                <InputNumber
                  min={0}
                  max={9999}
                  style={{ width: "100%" }}
                  placeholder={t('purchaseOrders.quantityPlaceholder')}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('purchaseOrders.unitPrice')}
                name="unit_price"
                rules={[{ required: true, message: t('purchaseOrders.unitPriceRequired') }]}
              >
                <InputNumber
                  min={0}
                  step={0.01}
                  style={{ width: "100%" }}
                  placeholder={t('purchaseOrders.unitPricePlaceholder')}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('purchaseOrders.taxRate')}
                name="tax_rate"
                initialValue={13}
              >
                <InputNumber
                  min={0}
                  max={100}
                  step={0.1}
                  style={{ width: "100%" }}
                  placeholder={t('purchaseOrders.taxRatePlaceholder')}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('purchaseOrders.amount')} name="amount">
                <InputNumber disabled style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('purchaseOrders.remark')} name="remark">
            <Input placeholder={t('purchaseOrders.remarkPlaceholder')} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
