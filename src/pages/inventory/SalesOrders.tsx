import { useEffect, useState } from "react";
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
import { runBusinessAction } from "../../utils/businessEngine";
import { useAuth } from "../../contexts/AuthContext";
import type { Tables } from "../../utils/supabase";
import dayjs from "dayjs";
import { SupaModal } from "../../components/SupaModal";
import { SuperTable } from "../../components/SuperTable";

type SalesOrder = Tables["erp_sales_orders_s_539dcf81_b"]["Row"];
type SalesOrderDetail = Tables["erp_sales_order_details_s_539dcf81_b"]["Row"];
type Customer = Tables["erp_customers_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];

const { Option } = Select;
const { TextArea } = Input;
const salesOrderTable = "erp_sales_orders_s_539dcf81_b";
const salesOrderDetailTable = "erp_sales_order_details_s_539dcf81_b";

export function SalesOrders() {
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
  const { user } = useAuth();

  useEffect(() => {
    fetchOrders();
    fetchCustomers();
    fetchProducts();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("erp_sales_orders_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("order_date", { ascending: false });

      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error("Error fetching orders:", error);
      message.error("获取数据失败");
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
        .from("erp_sales_order_details_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("order_id", orderId)
        .order("line_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching details:", error);
      message.error("获取明细失败");
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingOrder) {
        await logWithTiming("更新销售订单", "UPDATE", async () => {
          const { error } = await supabase
            .from(salesOrderTable)
            .update(values)
            .eq("id", editingOrder.id);
          if (error) throw error;
        }, { table: salesOrderTable, recordId: editingOrder.id });
        message.success("更新成功");
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: salesOrderTable,
        };
        const data = await logWithTiming("新增销售订单", "INSERT", async () => {
          const { data, error } = await supabase
            .from(salesOrderTable)
            .insert([values])
            .select()
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          return data;
        }, logParams);
        setSelectedOrder(data);
        message.success("新增成功");
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingOrder(null);
      fetchOrders();
    } catch (error) {
      console.error("Error saving order:", error);
      message.error("保存失败");
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedOrder) return;

      values.amount = (values.quantity || 0) * (values.unit_price || 0);
      values.tax_amount = values.amount * ((values.tax_rate || 0) / 100);

      if (editingDetail) {
        await supabase
          .from("erp_sales_order_details_s_539dcf81_b")
          .update(values)
          .eq("id", editingDetail.id);
        message.success("更新成功");
      } else {
        const maxLineNo =
          details.length > 0 ? Math.max(...details.map((d) => d.line_no)) : 0;
        values.line_no = maxLineNo + 1;
        values.order_id = selectedOrder.id;
        values.delivered_quantity = 0;
        values.is_deleted = "n";

        await supabase
          .from("erp_sales_order_details_s_539dcf81_b")
          .insert([values]);
        message.success("新增成功");
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedOrder.id);
      updateOrderTotal(selectedOrder.id);
    } catch (error) {
      console.error("Error saving detail:", error);
      message.error("保存失败");
    }
  };

  const updateOrderTotal = async (orderId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_sales_order_details_s_539dcf81_b")
        .select("amount, tax_amount")
        .eq("is_deleted", "n")
        .eq("order_id", orderId);
      if (error) throw error;

      const totalAmount =
        data?.reduce((sum, d) => sum + (d.amount || 0), 0) || 0;
      const taxAmount =
        data?.reduce((sum, d) => sum + (d.tax_amount || 0), 0) || 0;

      const order = orders.find((o) => o.id === orderId);
      const discountAmount = order?.discount_amount || 0;

      await supabase
        .from("erp_sales_orders_s_539dcf81_b")
        .update({
          total_amount: totalAmount,
          tax_amount: taxAmount,
          receivable_amount: totalAmount + taxAmount - discountAmount,
        })
        .eq("id", orderId);

      fetchOrders();
    } catch (error) {
      console.error("Error updating order total:", error);
    }
  };

  const businessUser = { id: user?.profile.id, username: user?.profile.username };

  const handleSubmitApproval = async (record: SalesOrder) => {
    try {
      await runBusinessAction({ action: 'submit', documentType: 'sales_order', documentId: record.id, user: businessUser });
      message.success('提交审批成功');
      fetchOrders();
    } catch (error: any) {
      console.error('Error submitting sales order:', error);
      message.error(error?.message || '提交审批失败');
    }
  };

  const handleApprove = async (record: SalesOrder) => {
    try {
      await runBusinessAction({ action: 'approve', documentType: 'sales_order', documentId: record.id, user: businessUser });
      message.success('审核成功');
      fetchOrders();
    } catch (error: any) {
      console.error('Error approving sales order:', error);
      message.error(error?.message || '审核失败');
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
      title: "确认删除",
      content: "确定要删除该订单吗？",
      onOk: async () => {
        try {
          await logWithTiming("删除销售订单", "DELETE", async () => {
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
          message.success("删除成功");
          fetchOrders();
        } catch (error) {
          console.error("Error deleting order:", error);
          message.error("删除失败");
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingOrder(null);
    setSelectedOrder(null);
    form.setFieldsValue({
      order_no: `SO${Date.now().toString().slice(-8)}`,
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
      title: "确认删除",
      content: "确定要删除该明细吗？",
      onOk: async () => {
        try {
          await supabase
            .from("erp_sales_order_details_s_539dcf81_b")
            .update({ is_deleted: "y" })
            .eq("id", id);
          message.success("删除成功");
          if (selectedOrder) {
            fetchDetails(selectedOrder.id);
            updateOrderTotal(selectedOrder.id);
          }
        } catch (error) {
          console.error("Error deleting detail:", error);
          message.error("删除失败");
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

  const getProductUnit = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.unit || "-";
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
    draft: { text: "草稿", color: "default" },
    pending: { text: "待审批", color: "warning" },
    approved: { text: "已审批", color: "success" },
    partially_delivered: { text: "部分发货", color: "processing" },
    delivered: { text: "已发货", color: "success" },
    closed: { text: "已关闭", color: "default" },
    cancelled: { text: "已取消", color: "error" },
  };

  const columns = [
    {
      title: "订单号",
      dataIndex: "order_no",
      key: "order_no",
    },
    {
      title: "客户",
      dataIndex: "customer_id",
      key: "customer_id",
      render: (customerId: number) => getCustomerName(customerId),
    },
    {
      title: "订单日期",
      dataIndex: "order_date",
      key: "order_date",
    },
    {
      title: "交货日期",
      dataIndex: "delivery_date",
      key: "delivery_date",
      render: (text: string) => text || "-",
    },
    {
      title: "金额",
      dataIndex: "total_amount",
      key: "total_amount",
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: "应收金额",
      dataIndex: "receivable_amount",
      key: "receivable_amount",
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (status: string) => {
        const config = statusLabels[status] || {
          text: status,
          color: "default",
        };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: SalesOrder) => (
        <Space size="middle">
          {record.status === 'draft' && (
            <Button type="text" onClick={() => handleSubmitApproval(record)} disabled={record.status !== 'draft'}>
              提交
            </Button>
          )}
          {record.status === 'pending' && (
            <Button type="text" onClick={() => handleApprove(record)}>
              审核
            </Button>
          )}
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
            disabled={['approved', 'partially_delivered', 'delivered', 'closed'].includes(record.status || '')}
          >
            编辑
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id)}
            disabled={record.status !== 'draft'}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    {
      title: "行号",
      dataIndex: "line_no",
      key: "line_no",
    },
    {
      title: "产品",
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: "单位",
      dataIndex: "product_id",
      key: "unit",
      render: (productId: number) => getProductUnit(productId),
    },
    {
      title: "数量",
      dataIndex: "quantity",
      key: "quantity",
      render: (qty: number) => qty?.toLocaleString() || "0",
    },
    {
      title: "单价",
      dataIndex: "unit_price",
      key: "unit_price",
      render: (price: number) => `¥${(price ?? 0).toFixed(2)}`,
    },
    {
      title: "金额",
      dataIndex: "amount",
      key: "amount",
      render: (amount: number) => `¥${(amount ?? 0).toFixed(2)}`,
    },
    {
      title: "税率(%)",
      dataIndex: "tax_rate",
      key: "tax_rate",
      render: (rate: number) => rate || "0",
    },
    {
      title: "税额",
      dataIndex: "tax_amount",
      key: "tax_amount",
      render: (amount: number) => `¥${(amount ?? 0).toFixed(2)}`,
    },
    {
      title: "已发数量",
      dataIndex: "delivered_quantity",
      key: "delivered_quantity",
      render: (qty: number) => qty?.toLocaleString() || "0",
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: SalesOrderDetail) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEditDetail(record)}
            disabled={isDisabled}
          >
            编辑
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDeleteDetail(record.id)}
            disabled={isDisabled}
          >
            删除
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
        storageKey="sales-orders"
        headerTitle="销售订单"
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              新增订单
            </Button>
            <Input.Search
              allowClear
              placeholder="搜索订单号或客户..."
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
            <span>{editingOrder ? "编辑销售订单" : "新增销售订单"}</span>
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
            {editingOrder?.status === "draft" ? "草稿" : "已审核"}
          </Tag>
        }
        headerPanelTitle="销售订单头"
        detailPanelTitle="销售订单明细"
        historyTable={salesOrderTable}
        historyRecordId={editingOrder?.id || selectedOrder?.id}
        workflowDocumentType="sales_order"
        form={form}
        detailExtra={
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleAddDetail}
            disabled={isDisabled}
          >
            新增明细
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
                  label="订单号"
                  name="order_no"
                  rules={[{ required: true, message: "请输入订单号" }]}
                >
                  <Input placeholder="请输入订单号" disabled={!!editingOrder} />
                </Form.Item>
                <Form.Item
                  label="客户"
                  name="customer_id"
                  rules={[{ required: true, message: "请选择客户" }]}
                >
                  <Select placeholder="请选择客户">
                    {customers.map((c) => (
                      <Option key={c.id} value={c.id}>
                        {c.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item
                  label="订单日期"
                  name="order_date"
                  rules={[{ required: true, message: "请选择订单日期" }]}
                >
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label="交货日期" name="delivery_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label="总金额" name="total_amount" initialValue={0}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder="请输入总金额"
                  />
                </Form.Item>
                <Form.Item label="税额" name="tax_amount" initialValue={0}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder="请输入税额"
                  />
                </Form.Item>
                <Form.Item
                  label="折扣金额"
                  name="discount_amount"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder="请输入折扣金额"
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="应收金额"
                  name="receivable_amount"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder="请输入应收金额"
                  />
                </Form.Item>
                <Form.Item label="币种" name="currency" initialValue="CNY">
                  <Select>
                    <Option value="CNY">人民币</Option>
                    <Option value="USD">美元</Option>
                    <Option value="EUR">欧元</Option>
                  </Select>
                </Form.Item>
                <Form.Item label="交货地址" name="delivery_address">
                  <Input placeholder="请输入交货地址" />
                </Form.Item>
                <Form.Item label="联系人" name="contact_person">
                  <Input placeholder="请输入联系人" />
                </Form.Item>
                <Form.Item label="联系电话" name="contact_phone">
                  <Input placeholder="请输入联系电话" />
                </Form.Item>
                <Form.Item label="备注" name="remark">
                  <TextArea rows={1} placeholder="请输入备注" />
                </Form.Item>
                <Form.Item label="状态" name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">草稿</Option>
                    <Option value="pending">待审批</Option>
                    <Option value="approved">已审批</Option>
                    <Option value="partially_delivered">部分发货</Option>
                    <Option value="delivered">已发货</Option>
                    <Option value="closed">已关闭</Option>
                    <Option value="cancelled">已取消</Option>
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
                  <strong>合计</strong>
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
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()} disabled={isDisabled}>
              保存
            </Button>
          </Space>
        }
        width={'70%'}
        height={680}
      />

      <Modal
        title={editingDetail ? "编辑销售订单明细" : "新增销售订单明细"}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsDetailModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => detailForm.submit()}>
              保存
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
            label="产品"
            name="product_id"
            rules={[{ required: true, message: "请选择产品" }]}
          >
            <Select
              placeholder="请选择产品"
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
                label="数量"
                name="quantity"
                rules={[{ required: true, message: "请输入数量" }]}
              >
                <InputNumber
                  min={1}
                  style={{ width: "100%" }}
                  placeholder="请输入数量"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="单价"
                name="unit_price"
                rules={[{ required: true, message: "请输入单价" }]}
              >
                <InputNumber
                  min={0}
                  step={0.01}
                  style={{ width: "100%" }}
                  placeholder="请输入单价"
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="税率(%)" name="tax_rate" initialValue={13}>
                <InputNumber
                  min={0}
                  max={100}
                  style={{ width: "100%" }}
                  placeholder="请输入税率"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="金额" name="amount">
                <InputNumber disabled style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="备注" name="remark">
            <Input placeholder="请输入备注" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

