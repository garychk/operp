import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Key } from "react";
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
import dayjs from "dayjs";
import { SupaModal } from "../../components/SupaModal";
import { SuperTable } from "../../components/SuperTable";
import { ProductUnit } from "../../components/ProductUnit";
import SimpleModal from "../../components/SimpleModal";

type SalesOrder = Tables["erp_sales_orders_s_539dcf81_b"]["Row"];
type SalesOrderDetail = Tables["erp_sales_order_details_s_539dcf81_b"]["Row"];
type Customer = Tables["erp_customers_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];

const { Option } = Select;
const { TextArea } = Input;
const salesOrderTable = "erp_sales_orders_s_539dcf81_b";
const salesOrderDetailTable = "erp_sales_order_details_s_539dcf81_b";
const docType = "sales_order";

export function SalesOrders() {
  const { t } = useTranslation();
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<SalesOrder | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<SalesOrder | null>(null);
  const [details, setDetails] = useState<SalesOrderDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<SalesOrderDetail | null>(
    null,
  );
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();
  const [isDisabled, setIsDisabled] = useState(false);

  useEffect(() => {
    fetchOrders();
    fetchCustomers();
    fetchProducts();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(salesOrderTable)
        .select("*")
        .eq("is_deleted", "n")
        .order("order_date", { ascending: false });

      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Error fetching orders:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const fetchCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_customers_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("status", "active");
      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error("Error fetching customers:", error);
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
        .from(salesOrderDetailTable)
        .select("*")
        .eq("is_deleted", "n")
        .eq("order_id", orderId)
        .order("line_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching details:", error);
      message.error(t("salesOrders.fetchDetailFailed"));
    }
  };

  const calculateOrderTotals = (
    detailRows: { amount: number | null; tax_amount: number | null }[],
    discountAmount = 0,
  ) => {
    const totalAmount = detailRows.reduce((sum, d) => sum + (d.amount || 0), 0);
    const taxAmount = detailRows.reduce(
      (sum, d) => sum + (d.tax_amount || 0),
      0,
    );
    return {
      total_amount: totalAmount,
      tax_amount: taxAmount,
      receivable_amount: totalAmount + taxAmount - discountAmount,
    };
  };

  const handleSubmit = async (values: any) => {
    try {
      const payload = {
        ...values,
        ...calculateOrderTotals(details, values.discount_amount || 0),
      };

      if (editingOrder) {
        await logWithTiming(t("salesOrders.logUpdate"), "UPDATE", async () => {
          const { error } = await supabase
            .from(salesOrderTable)
            .update(payload)
            .eq("id", editingOrder.id);
          if (error) throw error;
        }, { table: salesOrderTable, recordId: editingOrder.id });
        message.success(t("common.updateSuccess"));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: salesOrderTable,
        };
        const data = await logWithTiming(t("salesOrders.logCreate"), "INSERT", async () => {
          const { data, error } = await supabase
            .from(salesOrderTable)
            .insert([payload])
            .select()
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          return data;
        }, logParams);
        setSelectedOrder(data);
        message.success(t("common.createSuccess"));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingOrder(null);
      fetchOrders();
    } catch (error) {
      console.error("Error saving order:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedOrder) return;

      values.amount = (values.quantity || 0) * (values.unit_price || 0);
      values.tax_amount = values.amount * ((values.tax_rate || 0) / 100);

      if (editingDetail) {
        await supabase
          .from(salesOrderDetailTable)
          .update(values)
          .eq("id", editingDetail.id);
        message.success(t("common.updateSuccess"));
      } else {
        const maxLineNo =
          details.length > 0 ? Math.max(...details.map((d) => d.line_no)) : 0;
        values.line_no = maxLineNo + 1;
        values.order_id = selectedOrder.id;
        values.delivered_quantity = 0;
        values.is_deleted = "n";

        await supabase
          .from(salesOrderDetailTable)
          .insert([values]);
        message.success(t("common.createSuccess"));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedOrder.id);
      updateOrderTotal(selectedOrder.id);
    } catch (error) {
      console.error("Error saving detail:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const updateOrderTotal = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from(salesOrderDetailTable)
        .select("amount, tax_amount")
        .eq("is_deleted", "n")
        .eq("order_id", orderId);
      if (error) throw error;

      const order = orders.find((o) => o.id === orderId);
      const discountAmount = order?.discount_amount || 0;

      await supabase
        .from(salesOrderTable)
        .update(calculateOrderTotals(data || [], discountAmount))
        .eq("id", orderId);

      fetchOrders();
    } catch (error) {
      console.error("Error updating order total:", error);
    }
  };

  const handleEdit = async (record: SalesOrder) => {
    setEditingOrder(record);
    setIsDisabled(
      ["approved", "partially_delivered", "delivered", "closed"].includes(
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
      title: t("common.confirmDelete"),
      content: t("salesOrders.deleteOrderConfirm"),
      onOk: async () => {
        try {
          await logWithTiming(t("salesOrders.logDelete"), "DELETE", async () => {
            const { error } = await supabase
              .from(salesOrderTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
            const { error: detailError } = await supabase
              .from(salesOrderDetailTable)
              .update({ is_deleted: "y" })
              .eq("order_id", id);
            if (detailError) throw detailError;
          }, { table: salesOrderTable, recordId: id });
          message.success(t("common.deleteSuccess"));
          fetchOrders();
        } catch (error) {
          console.error("Error deleting order:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const handleAdd = async () => {
    setEditingOrder(null);
    setSelectedOrder(null);
    setIsDisabled(false);
    form.setFieldsValue({
      order_no: await nextDocumentNo(docType),
      order_date: dayjs(new Date()),
      customer_id: undefined,
      delivery_date: "",
      total_amount: 0,
      tax_amount: 0,
      discount_amount: 0,
      receivable_amount: 0,
      currency: "CNY",
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

  const handleEditDetail = (record: SalesOrderDetail) => {
    setEditingDetail(record);
    detailForm.setFieldsValue(record);    
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: t("common.confirmDelete"),
      content: t("salesOrders.deleteDetailConfirm"),
      onOk: async () => {
        try {
          await supabase
            .from(salesOrderDetailTable)
            .update({ is_deleted: "y" })
            .eq("id", id);
          message.success(t("common.deleteSuccess"));
          if (selectedOrder) {
            fetchDetails(selectedOrder.id);
            updateOrderTotal(selectedOrder.id);
          }
        } catch (error) {
          console.error("Error deleting detail:", error);
          message.error(t("common.deleteFailed"));
        }
      },
    });
  };

  const getCustomerName = (customerId: number | null) => {
    const customer = customers.find((c) => c.id === customerId);
    return customer?.name || "-";
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || "-";
  };

  const getProductPrice = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.sale_price || 0;
  };

  const filteredOrders = orders.filter(
    (o) =>
      o.order_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getCustomerName(o.customer_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t("salesOrders.statusDraft"), color: "default" },
    pending: { text: t("salesOrders.statusPending"), color: "warning" },
    approved: { text: t("salesOrders.statusApproved"), color: "success" },
    partially_delivered: { text: t("salesOrders.statusPartiallyDelivered"), color: "processing" },
    delivered: { text: t("salesOrders.statusDelivered"), color: "success" },
    closed: { text: t("salesOrders.statusClosed"), color: "default" },
    cancelled: { text: t("salesOrders.statusCancelled"), color: "error" },
  };

  const columns = [
    {
      title: t("salesOrders.orderNo"),
      dataIndex: "order_no",
      key: "order_no",
      width: 120,
    },
    {
      title: t("salesOrders.customer"),
      dataIndex: "customer_id",
      key: "customer_id",
      render: (customerId: number) => getCustomerName(customerId),
    },
    {
      title: t("salesOrders.orderDate"),
      dataIndex: "order_date",
      key: "order_date",
      width: 120,
    },
    {
      title: t("salesOrders.deliveryDate"),
      dataIndex: "delivery_date",
      key: "delivery_date",
      width: 120,
      render: (text: string) => text || "-",
    },
    {
      title: t("salesOrders.amount"),
      dataIndex: "total_amount",
      key: "total_amount",
      width: 120,
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: t("salesOrders.receivableAmount"),
      dataIndex: "receivable_amount",
      key: "receivable_amount",
      width: 120,
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 120,
      render: (status: string) => {
        const config = statusLabels[status] || {
          text: status,
          color: "default",
        };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 120,
      render: (_: any, record: SalesOrder) => (
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
            disabled={record.status !== 'draft'}
          >
            {t("common.delete")}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    {
      title: t("salesOrders.lineNo"),
      dataIndex: "line_no",
      key: "line_no",
    },
    {
      title: t("salesOrders.product"),
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t("salesOrders.unit"),
      dataIndex: "product_id",
      key: "unit",
      render: (productId: number) => <ProductUnit productId={productId} />,
    },
    {
      title: t("salesOrders.quantity"),
      dataIndex: "quantity",
      key: "quantity",
      render: (qty: number) => qty?.toLocaleString() || "0",
    },
    {
      title: t("salesOrders.unitPrice"),
      dataIndex: "unit_price",
      key: "unit_price",
      render: (price: number) => `¥${(price ?? 0).toFixed(2)}`,
    },
    {
      title: t("salesOrders.amount"),
      dataIndex: "amount",
      key: "amount",
      render: (amount: number) => `¥${(amount ?? 0).toFixed(2)}`,
    },
    {
      title: t("salesOrders.taxRate"),
      dataIndex: "tax_rate",
      key: "tax_rate",
      render: (rate: number) => rate || "0",
    },
    {
      title: t("salesOrders.taxAmount"),
      dataIndex: "tax_amount",
      key: "tax_amount",
      render: (amount: number) => `¥${(amount ?? 0).toFixed(2)}`,
    },
    {
      title: t("salesOrders.deliveredQuantity"),
      dataIndex: "delivered_quantity",
      key: "delivered_quantity",
      render: (qty: number) => qty?.toLocaleString() || "0",
    },
    {
      title: t("common.actions"),
      key: "action",
      render: (_: any, record: SalesOrderDetail) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEditDetail(record)}
            disabled={isDisabled}
          >
            {t("common.edit")}
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDeleteDetail(record.id)}
            disabled={isDisabled}
          >
            {t("common.delete")}
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
    <div className="mainContent">
      <SuperTable
        columns={columns}
        dataSource={filteredOrders}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey={docType}
        tableName={salesOrderTable}
        headerTitle={t("salesOrders.title")}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t("salesOrders.add")}
            </Button>
            <Input.Search
              allowClear
              placeholder={t("salesOrders.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchOrders}
              style={{ width: 240 }}
            />
          </Space>
        }
      />
      <SupaModal
        title={
          <>
            <ShoppingCartOutlined />
            <span>{editingOrder ? t("salesOrders.editTitle") : t("salesOrders.addTitle")}</span>
          </>
        }
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingOrder(null);
          setSelectedOrder(null);
        }}
        headerExtra={
          <Tag color={editingOrder?.status === "draft" ? "blue" : "green"}>
            {editingOrder?.status === "draft" ? t("salesOrders.statusDraft") : t("salesOrders.statusReviewed")}
          </Tag>
        }
        headerPanelTitle={t("salesOrders.headerPanelTitle")}
        detailPanelTitle={t("salesOrders.detailPanelTitle")}
        historyTable={salesOrderTable}
        historyRecordId={editingOrder?.id || selectedOrder?.id}
        workflowDocumentType={docType}
        onDataChanged={fetchOrders}
        detailData={details}
        form={form}
        detailExtra={
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleAddDetail}
            disabled={isDisabled}
          >
            {t("salesOrders.addDetail")}
          </Button>
        }
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
            style={{ padding: "0 16px 0 0" }}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t("salesOrders.orderNo")}
                  name="order_no"
                  rules={[{ required: true, message: t("salesOrders.orderNoRequired") }]}
                >
                  <Input placeholder={t("salesOrders.orderNoPlaceholder")} disabled={!!editingOrder} />
                </Form.Item>
                <Form.Item
                  label={t("salesOrders.customer")}
                  name="customer_id"
                  rules={[{ required: true, message: t("salesOrders.customerRequired") }]}
                >
                  <Select placeholder={t("salesOrders.customerPlaceholder")}>
                    {customers.map((c) => (
                      <Option key={c.id} value={c.id}>
                        {c.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label={t("salesOrders.orderDate")}
                  name="order_date"
                  rules={[{ required: true, message: t("salesOrders.orderDateRequired") }]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t("salesOrders.deliveryDate")} name="delivery_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label={t("salesOrders.totalAmount")} name="total_amount" initialValue={0}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("salesOrders.totalAmountPlaceholder")}
                  />
                </Form.Item>
                <Form.Item label={t("salesOrders.taxAmount")} name="tax_amount" initialValue={0}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("salesOrders.taxAmountPlaceholder")}
                  />
                </Form.Item>
                <Form.Item
                  label={t("salesOrders.discountAmount")}
                  name="discount_amount"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("salesOrders.discountAmountPlaceholder")}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t("salesOrders.receivableAmount")}
                  name="receivable_amount"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder={t("salesOrders.receivableAmountPlaceholder")}
                  />
                </Form.Item>
                <Form.Item label={t("salesOrders.currency")} name="currency" initialValue="CNY">
                  <Select>
                    <Option value="CNY">{t("salesOrders.currencyCny")}</Option>
                    <Option value="USD">{t("salesOrders.currencyUsd")}</Option>
                    <Option value="EUR">{t("salesOrders.currencyEur")}</Option>
                  </Select>
                </Form.Item>
                <Form.Item label={t("salesOrders.deliveryAddress")} name="delivery_address">
                  <Input placeholder={t("salesOrders.deliveryAddressPlaceholder")} />
                </Form.Item>
                <Form.Item label={t("salesOrders.contactPerson")} name="contact_person">
                  <Input placeholder={t("salesOrders.contactPersonPlaceholder")} />
                </Form.Item>
                <Form.Item label={t("salesOrders.contactPhone")} name="contact_phone">
                  <Input placeholder={t("salesOrders.contactPhonePlaceholder")} />
                </Form.Item>
                <Form.Item label={t("salesOrders.remark")} name="remark">
                  <TextArea rows={1} placeholder={t("salesOrders.remarkPlaceholder")} />
                </Form.Item>
                <Form.Item label={t("common.status")} name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">{t("salesOrders.statusDraft")}</Option>
                    <Option value="pending">{t("salesOrders.statusPending")}</Option>
                    <Option value="approved">{t("salesOrders.statusApproved")}</Option>
                    <Option value="partially_delivered">{t("salesOrders.statusPartiallyDelivered")}</Option>
                    <Option value="delivered">{t("salesOrders.statusDelivered")}</Option>
                    <Option value="closed">{t("salesOrders.statusClosed")}</Option>
                    <Option value="cancelled">{t("salesOrders.statusCancelled")}</Option>
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
                  <strong>{t("salesOrders.totalText")}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="left">
                  <strong>¥{detailTotal.amount.toFixed(2)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2}></Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="left">
                  <strong>¥{detailTotal.taxAmount.toFixed(2)}</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} colSpan={2}></Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => form.submit()} disabled={isDisabled}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={'70%'}
        height={680}
      />

      <SimpleModal
        title={editingDetail ? t("salesOrders.editDetailTitle") : t("salesOrders.addDetailTitle")}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsDetailModalOpen(false)}>{t("common.cancel")}</Button>
            <Button type="primary" onClick={() => detailForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={500}
      >
        <Form
          form={detailForm}
          layout="vertical"
          onFinish={handleDetailSubmit}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label={t("salesOrders.product")}
            name="product_id"
            rules={[{ required: true, message: t("salesOrders.productRequired") }]}
          >
            <Select
              placeholder={t("salesOrders.productPlaceholder")}
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
                label={t("salesOrders.quantity")}
                name="quantity"
                rules={[{ required: true, message: t("salesOrders.quantityRequired") }]}
              >
                <InputNumber
                  min={1}
                  style={{ width: "100%" }}
                  placeholder={t("salesOrders.quantityPlaceholder")}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t("salesOrders.unitPrice")}
                name="unit_price"
                rules={[{ required: true, message: t("salesOrders.unitPriceRequired") }]}
              >
                <InputNumber
                  min={0}
                  step={0.01}
                  style={{ width: "100%" }}
                  placeholder={t("salesOrders.unitPricePlaceholder")}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t("salesOrders.taxRate")} name="tax_rate" initialValue={13}>
                <InputNumber
                  min={0}
                  max={100}
                  style={{ width: "100%" }}
                  placeholder={t("salesOrders.taxRatePlaceholder")}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t("salesOrders.amount")} name="amount">
                <InputNumber disabled style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t("salesOrders.remark")} name="remark">
            <Input placeholder={t("salesOrders.remarkPlaceholder")} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}

