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
  CheckCircleOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import { nextDocumentNo } from "../../utils/documentNaming";
import { SuperTable } from "../../components/SuperTable";
import { useCurrencyRegistry } from "../../utils/money";
import { SupaModal } from "../../components/SupaModal";
import dayjs from "dayjs";

type SubcontractSettlement =
  Tables["erp_subcontract_settlements_s_539dcf81_b"]["Row"];
type SubcontractOrder = Tables["erp_subcontract_orders_s_539dcf81_b"]["Row"];
type SubcontractReceipt = Tables["erp_subcontract_receipts_s_539dcf81_b"]["Row"];
type Supplier = Tables["erp_suppliers_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];

const { Option } = Select;
const settlementTable = "erp_subcontract_settlements_s_539dcf81_b";
const orderTable = "erp_subcontract_orders_s_539dcf81_b";
const receiptTable = "erp_subcontract_receipts_s_539dcf81_b";

/**
 * deploy_103：结算只做「加工费差异确认」，**不再出凭证**。
 * 加工费应付在委外入库过账时就已经挂在供应商往来了，结算时再出一次凭证会重复计账。
 * 所以这个 RPC 的产物是：variance_amount + status='confirmed' + 推进订单 settled_quantity。
 */
const CONFIRM_RPC = "confirm_subcontract_settlement";
const DOCUMENT_TYPE = "subcontract_settlement";
const CONFIRMED_STATUS = "confirmed";

const isConfirmed = (record: { status: string | null }) =>
  record.status === CONFIRMED_STATUS;

const formatDateTime = (value: string | null | undefined) =>
  value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";

export function SubcontractSettlements() {
  const { t } = useTranslation();
  const { formatMoney, formatQuantity, currencyLabel, currencies } =
    useCurrencyRegistry();
  const [settlements, setSettlements] = useState<SubcontractSettlement[]>([]);
  const [orders, setOrders] = useState<SubcontractOrder[]>([]);
  const [receipts, setReceipts] = useState<SubcontractReceipt[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSettlement, setEditingSettlement] =
    useState<SubcontractSettlement | null>(null);
  const [selectedSettlement, setSelectedSettlement] =
    useState<SubcontractSettlement | null>(null);
  const [form] = Form.useForm();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    fetchSettlements();
    fetchOrders();
    fetchReceipts();
    fetchSuppliers();
    fetchProducts();
  }, []);

  const fetchSettlements = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(settlementTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("settlement_date", { ascending: false });
      if (error) throw error;
      setSettlements(data || []);
    } catch (error) {
      console.error("Error fetching subcontract settlements:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchOrders = async () => {
    const { data } = await supabase
      .from(orderTable)
      .select("*")
      .eq("is_deleted", "n");
    setOrders(data || []);
  };

  const fetchReceipts = async () => {
    const { data } = await supabase
      .from(receiptTable)
      .select("*")
      .eq("is_deleted", "n");
    setReceipts(data || []);
  };

  const fetchSuppliers = async () => {
    const { data } = await supabase
      .from("erp_suppliers_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setSuppliers(data || []);
  };

  const fetchProducts = async () => {
    const { data } = await supabase
      .from("erp_products_s_539dcf81_b")
      .select("*")
      .eq("is_deleted", "n");
    setProducts(data || []);
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload = {
        ...values,
        settlement_date: values.settlement_date
          ? dayjs(values.settlement_date).format("YYYY-MM-DD")
          : undefined,
        quantity: Number(values.quantity || 0),
        processing_fee_amount: Number(values.processing_fee_amount || 0),
        invoiced_amount: Number(values.invoiced_amount || 0),
      };
      if (editingSettlement) {
        await logWithTiming(
          "更新委外结算单",
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(settlementTable)
              .update(payload)
              .eq("id", editingSettlement.id);
            if (error) throw error;
          },
          { table: settlementTable, recordId: editingSettlement.id },
        );
        message.success(t("common.updateSuccess"));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: settlementTable,
        };
        const data = await logWithTiming(
          "新增委外结算单",
          "INSERT",
          async () => {
            const { data, error } = await supabase
              .from(settlementTable)
              .insert([payload])
              .select()
              .single();
            if (error) throw error;
            logParams.recordId = data.id;
            return data;
          },
          logParams,
        );
        setSelectedSettlement(data as SubcontractSettlement);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingSettlement(null);
      fetchSettlements();
    } catch (error) {
      console.error("Error saving subcontract settlement:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleEdit = (record: SubcontractSettlement) => {
    if (isConfirmed(record)) {
      message.warning(t("mrp.subcontractSettlements.confirmedLocked"));
      return;
    }
    setEditingSettlement(record);
    setSelectedSettlement(record);
    form.setFieldsValue({
      ...record,
      settlement_date: record.settlement_date
        ? dayjs(record.settlement_date)
        : undefined,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    const target = settlements.find((row) => row.id === id);
    if (target && isConfirmed(target)) {
      message.warning(t("mrp.subcontractSettlements.confirmedLocked"));
      return;
    }
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("mrp.subcontractSettlements.deleteConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(
            "删除委外结算单",
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(settlementTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
            },
            { table: settlementTable, recordId: id },
          );
          message.success(t("common.deleteSuccess"));
          fetchSettlements();
        } catch (error) {
          console.error("Error deleting subcontract settlement:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleConfirm = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = settlements.filter(
      (row) => selectedIds.has(row.id) && !isConfirmed(row),
    );
    if (targets.length === 0) {
      message.warning(t("mrp.subcontractSettlements.confirmNoTarget"));
      return;
    }
    Modal.confirm({
      title: t("mrp.subcontractSettlements.confirmAction"),
      content: t("mrp.subcontractSettlements.confirmContentMany", {
        count: targets.length,
      }),
      okText: t("common.continue"),
      cancelText: t("common.cancel"),
      onOk: async () => {
        setConfirming(true);
        let success = 0;
        const failures: string[] = [];
        try {
          for (const record of targets) {
            try {
              const { error } = await supabase.rpc(CONFIRM_RPC, {
                p_settlement_id: record.id,
                p_idempotency_key: crypto.randomUUID(),
              });
              if (error) throw error;
              success += 1;
            } catch (error: any) {
              console.error("Error confirming subcontract settlement:", error);
              failures.push(
                `${record.settlement_no}：${
                  error?.message || t("mrp.subcontractSettlements.confirmFailed")
                }`,
              );
            }
          }
          if (failures.length === 0) {
            message.success(
              t("mrp.subcontractSettlements.confirmSuccessMany", {
                count: success,
              }),
            );
          } else {
            message.error(
              t("mrp.subcontractSettlements.confirmPartialFailed", {
                success,
                failed: failures.length,
                detail: failures.join("；"),
              }),
            );
          }
          setSelectedRowKeys([]);
          await fetchSettlements();
          await fetchOrders();
        } finally {
          setConfirming(false);
        }
      },
    });
  };

  const handleAdd = async () => {
    let settlementNo: string;
    try {
      settlementNo = await nextDocumentNo(DOCUMENT_TYPE);
    } catch (error) {
      message.error(
        `${t("common.documentNoFailed")}：${(error as Error).message}`,
      );
      return;
    }
    setEditingSettlement(null);
    setSelectedSettlement(null);
    form.setFieldsValue({
      settlement_no: settlementNo,
      settlement_date: dayjs(new Date()),
      supplier_id: undefined,
      order_id: undefined,
      quantity: 0,
      processing_fee_amount: 0,
      invoiced_amount: 0,
      invoice_no: "",
      currency: currencies.find((c) => c.isBase)?.code,
      exchange_rate: 1,
      status: "draft",
      remark: "",
    });
    setIsModalOpen(true);
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || "-";
  };

  const getOrderNo = (orderId: number | null) => {
    if (!orderId) return "-";
    return orders.find((o) => o.id === orderId)?.order_no || "-";
  };

  const getProductLabel = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product ? `${product.code} - ${product.name}` : "-";
  };

  const getOrderLabel = (orderId: number | null) => {
    if (!orderId) return "-";
    const order = orders.find((o) => o.id === orderId);
    if (!order) return "-";
    return `${order.order_no}（${getProductLabel(order.product_id)}）`;
  };

  /**
   * 该订单已过账的入库单：用来给「系统侧加工费」和「结算数量」一个可核对的来源。
   * 结算单自己不落这两项的重算逻辑（后端也不重算），所以这里只是提示，不写回。
   */
  const postedFeeOfOrder = (orderId: number | null | undefined) => {
    if (!orderId) return { qty: 0, fee: 0, count: 0 };
    const posted = receipts.filter(
      (row) => row.order_id === orderId && row.status === "posted",
    );
    return {
      qty: posted.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      fee: posted.reduce((sum, row) => sum + Number(row.processing_fee || 0), 0),
      count: posted.length,
    };
  };

  const filteredSettlements = settlements.filter(
    (row) =>
      row.settlement_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getOrderNo(row.order_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(row.supplier_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()) ||
      (row.invoice_no || "").toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("mrp.subcontractSettlements.statusDraft"), color: "default" },
    confirmed: {
      text: t("mrp.subcontractSettlements.statusConfirmed"),
      color: "green",
    },
  };

  const columns = [
    {
      title: t("mrp.subcontractSettlements.settlementNo"),
      dataIndex: "settlement_no",
      key: "settlement_no",
    },
    {
      title: t("mrp.subcontractSettlements.settlementDate"),
      dataIndex: "settlement_date",
      key: "settlement_date",
      render: (text: string) => text || "-",
    },
    {
      title: t("mrp.subcontractSettlements.supplier"),
      dataIndex: "supplier_id",
      key: "supplier_id",
      render: (id: number) => getSupplierName(id),
    },
    {
      title: t("mrp.subcontractSettlements.order"),
      dataIndex: "order_id",
      key: "order_id",
      render: (id: number) => getOrderLabel(id),
    },
    {
      title: t("mrp.subcontractSettlements.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      align: "right" as const,
      render: (qty: number) => formatQuantity(qty),
    },
    {
      title: t("mrp.subcontractSettlements.processingFeeAmount"),
      dataIndex: "processing_fee_amount",
      key: "processing_fee_amount",
      align: "right" as const,
      render: (amount: number, record: SubcontractSettlement) =>
        formatMoney(amount, record.currency),
    },
    {
      title: t("mrp.subcontractSettlements.invoicedAmount"),
      dataIndex: "invoiced_amount",
      key: "invoiced_amount",
      align: "right" as const,
      render: (amount: number, record: SubcontractSettlement) =>
        formatMoney(amount, record.currency),
    },
    {
      title: t("mrp.subcontractSettlements.varianceAmount"),
      dataIndex: "variance_amount",
      key: "variance_amount",
      align: "right" as const,
      render: (amount: number, record: SubcontractSettlement) => (
        <span style={{ color: Number(amount) > 0 ? "#cf1322" : undefined }}>
          {formatMoney(amount, record.currency)}
        </span>
      ),
    },
    {
      title: t("mrp.subcontractSettlements.invoiceNo"),
      dataIndex: "invoice_no",
      key: "invoice_no",
      render: (text: string) => text || "-",
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
      title: t("mrp.subcontractSettlements.confirmedAt"),
      dataIndex: "confirmed_at",
      key: "confirmed_at",
      render: (text: string) => formatDateTime(text),
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: SubcontractSettlement) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            disabled={isConfirmed(record)}
            onClick={() => handleEdit(record)}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            disabled={isConfirmed(record)}
            onClick={() => handleDelete(record.id)}
          >
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  const editingOrderFee = postedFeeOfOrder(
    editingSettlement?.order_id ?? form.getFieldValue("order_id"),
  );

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredSettlements}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="subcontract-settlements"
        headerTitle={t("mrp.subcontractSettlements.title")}
        toolbarActions={["export"]}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("mrp.subcontractSettlements.add")}
            </Button>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={confirming}
              disabled={selectedRowKeys.length === 0}
              onClick={handleConfirm}
            >
              {t("mrp.subcontractSettlements.confirmAction")}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ""}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("mrp.subcontractSettlements.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchSettlements}
              style={{ width: 260 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={
          editingSettlement
            ? t("mrp.subcontractSettlements.editTitle")
            : t("mrp.subcontractSettlements.addTitle")
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingSettlement(null);
          setSelectedSettlement(null);
        }}
        headerPanelTitle={t("mrp.subcontractSettlements.headerPanelTitle")}
        detailPanelTitle={t("mrp.subcontractSettlements.detailPanelTitle")}
        historyTable={settlementTable}
        historyRecordId={editingSettlement?.id || selectedSettlement?.id}
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
                  label={t("mrp.subcontractSettlements.settlementNo")}
                  name="settlement_no"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractSettlements.settlementNoPrompt"),
                    },
                  ]}
                >
                  <Input disabled={!!editingSettlement} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractSettlements.settlementDate")}
                  name="settlement_date"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractSettlements.settlementDatePrompt"),
                    },
                  ]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractSettlements.supplier")}
                  name="supplier_id"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractSettlements.supplierPrompt"),
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
                  label={t("mrp.subcontractSettlements.order")}
                  name="order_id"
                  extra={t("mrp.subcontractSettlements.orderHint")}
                >
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="children"
                    onChange={(value: number | undefined) => {
                      const picked = orders.find((o) => o.id === value);
                      if (!picked) return;
                      const posted = postedFeeOfOrder(value);
                      form.setFieldsValue({
                        supplier_id: picked.supplier_id,
                        quantity: posted.qty || Number(picked.received_quantity || 0),
                        // 只做「填个初值」：系统侧加工费来自已过账入库单的实际值，
                        // 后端在确认时也不会重算 —— 对不上就该由业务人员改。
                        processing_fee_amount:
                          posted.fee || Number(picked.amount || 0),
                        currency: picked.currency,
                        exchange_rate: picked.exchange_rate,
                      });
                    }}
                  >
                    {orders.map((o) => (
                      <Option key={o.id} value={o.id}>
                        {o.order_no}（{getProductLabel(o.product_id)}）
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("mrp.subcontractSettlements.quantity")}
                  name="quantity"
                  rules={[
                    {
                      required: true,
                      message: t("mrp.subcontractSettlements.quantityPrompt"),
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
                  label={t("mrp.subcontractSettlements.processingFeeAmount")}
                  name="processing_fee_amount"
                  rules={[
                    {
                      required: true,
                      message: t(
                        "mrp.subcontractSettlements.processingFeeAmountPrompt",
                      ),
                    },
                  ]}
                >
                  <InputNumber
                    min={0}
                    step={0.01}
                    precision={2}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractSettlements.invoicedAmount")}
                  name="invoiced_amount"
                  rules={[
                    {
                      required: true,
                      message: t(
                        "mrp.subcontractSettlements.invoicedAmountPrompt",
                      ),
                    },
                  ]}
                >
                  <InputNumber
                    min={0}
                    step={0.01}
                    precision={2}
                    style={{ width: "100%" }}
                  />
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractSettlements.invoiceNo")}
                  name="invoice_no"
                >
                  <Input />
                </Form.Item>
                <Row gutter={8}>
                  <Col span={14}>
                    <Form.Item
                      label={t("mrp.subcontractSettlements.currency")}
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
                      label={t("mrp.subcontractSettlements.exchangeRate")}
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
                  label={t("common.status")}
                  name="status"
                  initialValue="draft"
                >
                  <Select disabled>
                    <Option value="draft">
                      {t("mrp.subcontractSettlements.statusDraft")}
                    </Option>
                    <Option value="confirmed">
                      {t("mrp.subcontractSettlements.statusConfirmed")}
                    </Option>
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("mrp.subcontractSettlements.remark")}
                  name="remark"
                >
                  <Input.TextArea rows={2} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        tableEle={
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            <Alert
              type="info"
              showIcon
              message={t("mrp.subcontractSettlements.noVoucherTitle")}
              description={t("mrp.subcontractSettlements.noVoucherDesc")}
            />
            {editingOrderFee.count > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t("mrp.subcontractSettlements.postedFeeTitle", {
                  count: editingOrderFee.count,
                })}
                description={t("mrp.subcontractSettlements.postedFeeDesc", {
                  qty: editingOrderFee.qty,
                  fee: formatMoney(editingOrderFee.fee),
                })}
              />
            )}
            {isConfirmed(selectedSettlement || ({} as SubcontractSettlement)) &&
              selectedSettlement && (
                <Descriptions size="small" column={3} bordered>
                  <Descriptions.Item
                    label={t("mrp.subcontractSettlements.processingFeeAmount")}
                  >
                    {formatMoney(
                      selectedSettlement.processing_fee_amount,
                      selectedSettlement.currency,
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item
                    label={t("mrp.subcontractSettlements.invoicedAmount")}
                  >
                    {formatMoney(
                      selectedSettlement.invoiced_amount,
                      selectedSettlement.currency,
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item
                    label={t("mrp.subcontractSettlements.varianceAmount")}
                  >
                    {formatMoney(
                      selectedSettlement.variance_amount,
                      selectedSettlement.currency,
                    )}
                  </Descriptions.Item>
                </Descriptions>
              )}
            <Table
              columns={[
                { title: "#", dataIndex: "line_no", key: "line_no", width: 60 },
                {
                  title: t("mrp.subcontractSettlements.receiptNo"),
                  dataIndex: "receipt_no",
                  key: "receipt_no",
                },
                {
                  title: t("mrp.subcontractSettlements.receiptDate"),
                  dataIndex: "receipt_date",
                  key: "receipt_date",
                },
                {
                  title: t("mrp.subcontractSettlements.quantity"),
                  dataIndex: "quantity",
                  key: "quantity",
                  align: "right" as const,
                  render: (qty: number) => formatQuantity(qty),
                },
                {
                  title: t("mrp.subcontractSettlements.processingFeeAmount"),
                  dataIndex: "processing_fee",
                  key: "processing_fee",
                  align: "right" as const,
                  render: (amount: number, row: SubcontractReceipt) =>
                    formatMoney(amount, row.currency),
                },
                {
                  title: t("mrp.subcontractSettlements.materialCost"),
                  dataIndex: "material_cost",
                  key: "material_cost",
                  align: "right" as const,
                  render: (amount: number, row: SubcontractReceipt) =>
                    formatMoney(amount, row.currency),
                },
              ]}
              dataSource={receipts
                .filter(
                  (row) =>
                    row.order_id ===
                    (editingSettlement?.order_id ?? form.getFieldValue("order_id")),
                )
                .map((row, index) => ({ ...row, line_no: index + 1 }))}
              rowKey="id"
              pagination={false}
              size="small"
              title={() => t("mrp.subcontractSettlements.receiptsTitle")}
              locale={{ emptyText: t("mrp.subcontractSettlements.receiptsEmpty") }}
            />
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
              disabled={!!editingSettlement && isConfirmed(editingSettlement)}
            >
              {t("common.save")}
            </Button>
          </Space>
        }
        width={"78%"}
        height={"80%"}
      />
    </div>
  );
}
