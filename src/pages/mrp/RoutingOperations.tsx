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
  Checkbox,
  Row,
  Col,
  DatePicker,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ShoppingOutlined,
  CheckOutlined,
  PrinterOutlined,
  AppstoreOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import dayjs from "dayjs";
import { SupaModal } from "../../components/SupaModal";
import { RoutingMap } from "../../components/RoutingMap";

type Routing = Tables["erp_routing_operations_s_539dcf81_b"]["Row"];
type RoutingDetail =
  Tables["erp_routing_operation_details_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Operation = Tables["erp_operations_s_539dcf81_b"]["Row"];

const { Option } = Select;
const routingTable = "erp_routing_operations_s_539dcf81_b";
const routingDetailTable = "erp_routing_operation_details_s_539dcf81_b";

export function RoutingOperations() {
  const [routings, setRoutings] = useState<Routing[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingRouting, setEditingRouting] = useState<Routing | null>(null);
  const [selectedRouting, setSelectedRouting] = useState<Routing | null>(null);
  const [details, setDetails] = useState<RoutingDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<RoutingDetail | null>(
    null,
  );
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();

  useEffect(() => {
    fetchRoutings();
    fetchProducts();
    fetchOperations();
  }, []);

  const fetchOperations = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_operations_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setOperations(data || []);
    } catch (error) {
      console.error("Error fetching operations:", error);
    }
  };

  const fetchRoutings = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("erp_routing_operations_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setRoutings(data || []);
    } catch (error) {
      console.error("Error fetching routings:", error);
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

  const fetchDetails = async (routingId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_routing_operation_details_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("routing_id", routingId)
        .order("sequence_no");
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error("Error fetching details:", error);
      message.error("获取明细失败");
    }
  };

  const handleShowMap = async (record: Routing) => {
    await fetchDetails(record.id);
    setSelectedRouting(record);
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingRouting) {
        await logWithTiming(
          "更新工艺路线",
          "UPDATE",
          async () => {
            const { error } = await supabase
              .from(routingTable)
              .update(values)
              .eq("id", editingRouting.id);
            if (error) throw error;
          },
          { table: routingTable, recordId: editingRouting.id },
        );
        message.success("更新成功");
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: routingTable,
        };
        const data = await logWithTiming(
          "新增工艺路线",
          "INSERT",
          async () => {
            const { data, error } = await supabase
              .from(routingTable)
              .insert([values])
              .select()
              .single();
            if (error) throw error;
            logParams.recordId = data.id;
            return data;
          },
          logParams,
        );
        setSelectedRouting(data);
        message.success("新增成功");
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingRouting(null);
      fetchRoutings();
    } catch (error) {
      console.error("Error saving routing:", error);
      message.error("保存失败");
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedRouting) {
        message.error("请先选择工艺路线");
        return;
      }

      if (editingDetail) {
        await supabase
          .from("erp_routing_operation_details_s_539dcf81_b")
          .update(values)
          .eq("id", editingDetail.id);
        message.success("更新成功");
      } else {
        values.routing_id = selectedRouting.id;
        values.is_deleted = "n";

        const { error } = await supabase
          .from("erp_routing_operation_details_s_539dcf81_b")
          .insert([values]);
        if (error) throw error;
        message.success("新增成功");
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedRouting.id);
      updateRoutingTotal(selectedRouting.id);
    } catch (error) {
      console.error("Error saving detail:", error);
      message.error("保存失败");
    }
  };

  const updateRoutingTotal = async (routingId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_routing_operation_details_s_539dcf81_b")
        .select("standard_hours")
        .eq("is_deleted", "n")
        .eq("routing_id", routingId);
      if (error) throw error;

      const totalHours =
        data?.reduce((sum, d) => sum + (d.standard_hours || 0), 0) || 0;

      await supabase
        .from("erp_routing_operations_s_539dcf81_b")
        .update({ total_standard_hours: totalHours })
        .eq("id", routingId);

      fetchRoutings();
    } catch (error) {
      console.error("Error updating routing total:", error);
    }
  };

  const handleEdit = async (record: Routing) => {
    setEditingRouting(record);
    const formValues = { ...record };
    if (formValues.effective_date) {
      formValues.effective_date = dayjs(formValues.effective_date);
    }
    if (formValues.expiry_date) {
      formValues.expiry_date = dayjs(formValues.expiry_date);
    }
    form.setFieldsValue(formValues);
    setSelectedRouting(record);
    await fetchDetails(record.id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: "确认删除",
      content: "确定要删除该工艺路线吗？",
      onOk: async () => {
        try {
          await logWithTiming(
            "删除工艺路线",
            "DELETE",
            async () => {
              const { error } = await supabase
                .from(routingTable)
                .update({ is_deleted: "y" })
                .eq("id", id);
              if (error) throw error;
              const { error: detailError } = await supabase
                .from(routingDetailTable)
                .update({ is_deleted: "y" })
                .eq("routing_id", id);
              if (detailError) throw detailError;
            },
            { table: routingTable, recordId: id },
          );
          message.success("删除成功");
          fetchRoutings();
        } catch (error) {
          console.error("Error deleting routing:", error);
          message.error("删除失败");
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingRouting(null);
    form.setFieldsValue({
      routing_no: "",
      product_id: undefined,
      version: "1.0",
      is_default: true,
      is_active: true,
      effective_date: dayjs(new Date()),
      expiry_date: "",
      total_standard_hours: 0,
      remark: "",
    });
    setDetails([]);
    setSelectedRouting(null);
    setIsModalOpen(true);
  };

  const handleAddDetail = () => {
    setEditingDetail(null);
    detailForm.setFieldsValue({
      sequence_no: details.length + 1,
      operation_id: undefined,
      next_operation_id: undefined,
      standard_hours: 0,
      setup_hours: 0,
      labor_rate: 0,
      overhead_rate: 0,
      is_inspection_required: false,
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: RoutingDetail) => {
    setEditingDetail(record);
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: "确认删除",
      content: "确定要删除该工序吗？",
      onOk: async () => {
        try {
          await supabase
            .from("erp_routing_operation_details_s_539dcf81_b")
            .update({ is_deleted: "y" })
            .eq("id", id);
          message.success("删除成功");
          if (selectedRouting) {
            fetchDetails(selectedRouting.id);
            updateRoutingTotal(selectedRouting.id);
          }
        } catch (error) {
          console.error("Error deleting detail:", error);
          message.error("删除失败");
        }
      },
    });
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || "-";
  };

  const getOperationName = (operationId: number | null) => {
    const operation = operations.find((op) => op.id === operationId);
    return operation?.name || "-";
  };

  const filteredRoutings = routings.filter(
    (r) =>
      r.routing_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductName(r.product_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const columns = [
    {
      title: "工艺路线编号",
      dataIndex: "routing_no",
      key: "routing_no",
    },
    {
      title: "产品",
      dataIndex: "product_id",
      key: "product_id",
      render: (productId: number) => getProductName(productId),
    },
    {
      title: "版本",
      dataIndex: "version",
      key: "version",
    },
    {
      title: "标准工时",
      dataIndex: "total_standard_hours",
      key: "total_standard_hours",
      render: (hours: number) => `${hours}小时`,
    },
    {
      title: "默认",
      dataIndex: "is_default",
      key: "is_default",
      render: (isDefault: boolean) => (isDefault ? "是" : "否"),
    },
    {
      title: "状态",
      dataIndex: "is_active",
      key: "is_active",
      render: (isActive: boolean) => (
        <Tag color={isActive ? "success" : "default"}>
          {isActive ? "启用" : "停用"}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: Routing) => (
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
            icon={<AppstoreOutlined />}
            onClick={() => handleShowMap(record)}
          >
            图形
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

  const detailColumns = [
    {
      title: "序号",
      dataIndex: "sequence_no",
      key: "sequence_no",
    },
    {
      title: "工序名称",
      dataIndex: "operation_id",
      key: "operation_id",
      render: (operationId: number) => getOperationName(operationId),
    },
    {
      title: "标准工时(小时)",
      dataIndex: "standard_hours",
      key: "standard_hours",
      render: (hours: number) => hours || 0,
    },
    {
      title: "准备工时(小时)",
      dataIndex: "setup_hours",
      key: "setup_hours",
      render: (hours: number) => hours || 0,
    },
    {
      title: "人工费率",
      dataIndex: "labor_rate",
      key: "labor_rate",
      render: (rate: number) => rate || 0,
    },
    {
      title: "制造费用率",
      dataIndex: "overhead_rate",
      key: "overhead_rate",
      render: (rate: number) => rate || 0,
    },
    {
      title: "是否检验",
      dataIndex: "is_inspection_required",
      key: "is_inspection_required",
      render: (isRequired: boolean) => (isRequired ? "是" : "否"),
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: RoutingDetail) => (
        <Space size="middle">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEditDetail(record)}
          >
            编辑
          </Button>
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDeleteDetail(record.id)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const detailTotal = details.reduce(
    (acc, d) => acc + (d.standard_hours || 0),
    0,
  );

  return (
    <Card
      variant="borderless"
      title="工艺路线管理"
      className='mainContent'
      extra={
        <Space>
          <Input.Search placeholder="搜索工艺路线编号或产品..." allowClear onSearch={(value) => {
            setSearchTerm(value);
            fetchRoutings();
          }} />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增工艺路线
          </Button>
        </Space>
      }
    >
      <Table
        columns={columns}
        dataSource={filteredRoutings}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <RoutingMap
        details={details}
        operations={operations}
        routingNo={selectedRouting?.routing_no || ""}
      />

      <SupaModal
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingRouting(null);
          setSelectedRouting(null);
        }}
        title={
          <>
            <ShoppingOutlined />
            <span>{editingRouting ? "编辑工艺路线" : "新增工艺路线"}</span>
          </>
        }
        headerExtra={
          <Space>
            <Button
              type="dashed"
              color="purple"
              size="small"
              icon={<CheckOutlined />}
            >
              审核
            </Button>
            <Button
              type="dashed"
              color="purple"
              size="small"
              icon={<PrinterOutlined />}
            >
              打印
            </Button>
          </Space>
        }
        headerPanelTitle="工艺路线头"
        detailPanelTitle="工艺路线工序明细"
        historyTable={routingTable}
        historyRecordId={editingRouting?.id || selectedRouting?.id}
        detailExtra={
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={handleAddDetail}
          >
            新增工序
          </Button>
        }
        form={form}
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
                  label="工艺路线编号"
                  name="routing_no"
                  rules={[{ required: true, message: "请输入工艺路线编号" }]}
                >
                  <Input
                    placeholder="请输入工艺路线编号"
                    disabled={!!editingRouting}
                  />
                </Form.Item>
                <Form.Item
                  label="产品"
                  name="product_id"
                  rules={[{ required: true, message: "请选择产品" }]}
                >
                  <Select placeholder="请选择产品" disabled={!!editingRouting}>
                    {products.map((p) => (
                      <Option key={p.id} value={p.id}>
                        {p.name}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item label="版本" name="version" initialValue="1.0">
                  <Input placeholder="请输入版本" />
                </Form.Item>
                <Form.Item
                  label="标准工时(小时)"
                  name="total_standard_hours"
                  initialValue={0}
                >
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder="请输入标准工时"
                  />
                </Form.Item>
                <Form.Item
                  label="设为默认工艺路线"
                  name="is_default"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="生效日期" name="effective_date">
                  <DatePicker />
                </Form.Item>
                <Form.Item label="失效日期" name="expiry_date">
                  <DatePicker />
                </Form.Item>
                <Form.Item label="备注" name="remark">
                  <Input.TextArea rows={5} placeholder="请输入备注" />
                </Form.Item>
                <Form.Item
                  label="启用"
                  name="is_active"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
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
                <Table.Summary.Cell index={0} colSpan={3} align="right">
                  <strong>合计</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="left">
                  <strong>{detailTotal}小时</strong>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2}></Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
        height={680}
      />

      <Modal
        title={editingDetail ? "编辑工艺路线工序" : "新增工艺路线工序"}
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
        width={600}
        height={400}
      >
        <Form
          form={detailForm}
          layout="vertical"
          onFinish={handleDetailSubmit}
          style={{ marginRight: 16 }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="序号"
                name="sequence_no"
                rules={[{ required: true, message: "请输入序号" }]}
              >
                <InputNumber
                  min={1}
                  style={{ width: "100%" }}
                  placeholder="请输入序号"
                />
              </Form.Item>
              <Form.Item
                label="工序名称"
                name="operation_id"
                rules={[{ required: true, message: "请选择工序" }]}
              >
                <Select placeholder="请选择工序">
                  {operations.map((op) => (
                    <Option key={op.id} value={op.id}>
                      {op.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="下一道工序" name="next_operation_id">
                <Select placeholder="请选择下一道工序" allowClear>
                  {operations.map((op) => (
                    <Option key={op.id} value={op.id}>
                      {op.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item
                label="标准工时(小时)"
                name="standard_hours"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.1}
                  style={{ width: "100%" }}
                  placeholder="请输入标准工时"
                />
              </Form.Item>
              <Form.Item
                label="准备工时(小时)"
                name="setup_hours"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.1}
                  style={{ width: "100%" }}
                  placeholder="请输入准备工时"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="人工费率" name="labor_rate" initialValue={0}>
                <InputNumber
                  min={0}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                  placeholder="请输入人工费率"
                />
              </Form.Item>
              <Form.Item
                label="制造费用率"
                name="overhead_rate"
                initialValue={0}
              >
                <InputNumber
                  min={0}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                  placeholder="请输入制造费用率"
                />
              </Form.Item>
              <Form.Item
                label="是否需要检验"
                name="is_inspection_required"
                valuePropName="checked"
                initialValue={false}
              >
                <Checkbox />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
