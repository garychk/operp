import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Table,
  Tag,
  Modal,
  Form,
  Select,
  Space,
  Card,
  message,
  InputNumber,
  DatePicker,
  Row,
  Col,
} from "antd";
import {
  PlusOutlined,
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import dayjs from "dayjs";

type ProductionOrder = Tables["erp_production_orders_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Bom = Tables["erp_boms_s_539dcf81_b"]["Row"];
type WorkCenter = Tables["erp_work_centers_s_539dcf81_b"]["Row"];

const { Option } = Select;

export function ProductionOrders() {
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [boms, setBoms] = useState<Bom[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<ProductionOrder | null>(
    null,
  );
  const [form] = Form.useForm();

  useEffect(() => {
    fetchOrders();
    fetchProducts();
    fetchBoms();
    fetchWorkCenters();
  }, []);

  const fetchOrders = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("erp_production_orders_s_539dcf81_b")
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

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("is_manufactured", true);
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
    }
  };

  const fetchBoms = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_boms_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("is_active", true);
      if (error) throw error;
      setBoms(data || []);
    } catch (error) {
      console.error("Error fetching boms:", error);
    }
  };

  const fetchWorkCenters = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_work_centers_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setWorkCenters(data || []);
    } catch (error) {
      console.error("Error fetching work centers:", error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingOrder) {
        await logWithTiming("更新生产订单", "UPDATE", async () => {
          const { error } = await supabase
            .from("erp_production_orders_s_539dcf81_b")
            .update(values)
            .eq("id", editingOrder.id);
          if (error) throw error;
        });
        message.success("更新成功");
      } else {
        await logWithTiming("新增生产订单", "INSERT", async () => {
          const { error } = await supabase
            .from("erp_production_orders_s_539dcf81_b")
            .insert([values]);
          if (error) throw error;
        });
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

  const handleEdit = (record: ProductionOrder) => {
    setEditingOrder(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: "确认删除",
      content: "确定要删除该生产订单吗？",
      onOk: async () => {
        try {
          await logWithTiming("删除生产订单", "DELETE", async () => {
            const { error } = await supabase
              .from("erp_production_orders_s_539dcf81_b")
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
          });
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
    form.setFieldsValue({
      order_no: `MO${Date.now().toString().slice(-8)}`,
      order_date: dayjs(new Date()),
      product_id: undefined,
      bom_id: undefined,
      planned_quantity: 1,
      planned_start_date: "",
      planned_end_date: "",
      work_center_id: undefined,
      priority: 1,
      remark: "",
      status: "draft",
    });
    setIsModalOpen(true);
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || "-";
  };

  const getWorkCenterName = (workCenterId: number | null) => {
    const workCenter = workCenters.find((w) => w.id === workCenterId);
    return workCenter?.name || "-";
  };

  const filteredOrders = orders.filter(
    (o) =>
      o.order_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductName(o.product_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: "草稿", color: "default" },
    planned: { text: "已计划", color: "processing" },
    released: { text: "已下达", color: "warning" },
    in_progress: { text: "生产中", color: "blue" },
    completed: { text: "已完成", color: "success" },
    closed: { text: "已关闭", color: "default" },
    cancelled: { text: "已取消", color: "error" },
  };

  const priorityLabels: Record<number, string> = {
    1: "低",
    2: "中",
    3: "高",
    4: "紧急",
  };

  const columns = [
    {
      title: "订单号",
      dataIndex: "order_no",
      key: "order_no",
    },
    {
      title: "产品",
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: "计划数量",
      dataIndex: "planned_quantity",
      key: "planned_quantity",
    },
    {
      title: "完成数量",
      dataIndex: "completed_quantity",
      key: "completed_quantity",
      render: (qty: number) => qty || 0,
    },
    {
      title: "计划开始",
      dataIndex: "planned_start_date",
      key: "planned_start_date",
      render: (text: string) => text || "-",
    },
    {
      title: "计划结束",
      dataIndex: "planned_end_date",
      key: "planned_end_date",
      render: (text: string) => text || "-",
    },
    {
      title: "工作中心",
      dataIndex: "work_center_id",
      key: "work_center_id",
      render: (workCenterId: number) => getWorkCenterName(workCenterId),
    },
    {
      title: "优先级",
      dataIndex: "priority",
      key: "priority",
      render: (priority: number) => priorityLabels[priority] || "低",
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
      render: (_: any, record: ProductionOrder) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      variant="borderless"
      title="生产订单"
      extra={
        <Space>
          <Input
          placeholder="搜索订单号或产品..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          新增订单
        </Button>
        </Space>
      }
    >
      <Table
        columns={columns}
        dataSource={filteredOrders}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingOrder ? "编辑生产订单" : "新增生产订单"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingOrder(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          style={{ marginTop: 16 }}
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
                label="产品"
                name="product_id"
                rules={[{ required: true, message: "请选择产品" }]}
              >
                <Select placeholder="请选择产品" disabled={!!editingOrder}>
                  {products.map((p) => (
                    <Option key={p.id} value={p.id}>
                      {p.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="BOM" name="bom_id">
                <Select placeholder="请选择BOM">
                  {boms.map((b) => (
                    <Option key={b.id} value={b.id}>
                      {b.bom_no}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item
                label="计划数量"
                name="planned_quantity"
                initialValue={1}
              >
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder="请输入计划数量"
                />
              </Form.Item>
              <Form.Item label="计划开始日期" name="planned_start_date">
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
              <Form.Item label="计划结束日期" name="planned_end_date">
                <DatePicker style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="工作中心" name="work_center_id">
                <Select placeholder="请选择工作中心">
                  {workCenters.map((w) => (
                    <Option key={w.id} value={w.id}>
                      {w.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="优先级" name="priority" initialValue={1}>
                <Select>
                  <Option value={1}>低</Option>
                  <Option value={2}>中</Option>
                  <Option value={3}>高</Option>
                  <Option value={4}>紧急</Option>
                </Select>
              </Form.Item>
              <Form.Item label="备注" name="remark">
                <Input.TextArea rows={5} placeholder="请输入备注" />
              </Form.Item>
              <Form.Item label="状态" name="status" initialValue="draft">
                <Select>
                  <Option value="draft">草稿</Option>
                  <Option value="planned">已计划</Option>
                  <Option value="released">已下达</Option>
                  <Option value="in_progress">生产中</Option>
                  <Option value="completed">已完成</Option>
                  <Option value="closed">已关闭</Option>
                  <Option value="cancelled">已取消</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
