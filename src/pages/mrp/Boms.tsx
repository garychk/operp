import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Table,
  Tag,
  Modal,
  Drawer,
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
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import type { Tables } from "../../utils/supabase";
import dayjs from 'dayjs';
import SupaModal from "../../components/SupaModal";
import DictSelect from "../../components/DictSelect";
import { BomEditableTreeGraph } from "../../components/BomEditableTreeGraph";

type Bom = Tables["erp_boms_s_539dcf81_b"]["Row"];
type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type Operation = Tables["erp_operations_s_539dcf81_b"]["Row"];
type BomDetail = Tables["erp_bom_details_s_539dcf81_b"]["Row"];

const { Option } = Select;
const bomTable = "erp_boms_s_539dcf81_b";
const bomDetailTable = "erp_bom_details_s_539dcf81_b";

export function Boms() {
  const [boms, setBoms] = useState<Bom[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingBom, setEditingBom] = useState<Bom | null>(null);
  const [selectedBom, setSelectedBom] = useState<Bom | null>(null);
  const [details, setDetails] = useState<BomDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<BomDetail | null>(null);
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const [treeMaterialCode, setTreeMaterialCode] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();

  useEffect(() => {
    fetchBoms();
    fetchProducts();
    fetchAllProducts();
    fetchOperations();
  }, []);

  const fetchBoms = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("erp_boms_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setBoms(data || []);
    } catch (error) {
      console.error("Error fetching boms:", error);
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

  const fetchAllProducts = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setAllProducts(data || []);
    } catch (error) {
      console.error("Error fetching all products:", error);
    }
  };

  const fetchOperations = async () => {
    try {
      const { data, error } = await supabase
        .from("erp_operations_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n");
      if (error) throw error;
      setOperations(data || []);
    } catch (error) {
      console.error("Error fetching operations:", error);
    }
  };

  const fetchDetails = async (bomId: number) => {
    try {
      const { data, error } = await supabase
        .from("erp_bom_details_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .eq("bom_id", bomId)
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
      if (editingBom) {
        await logWithTiming("更新BOM", "UPDATE", async () => {
          const { error } = await supabase
            .from(bomTable)
            .update(values)
            .eq("id", editingBom.id);
          if (error) throw error;
        }, { table: bomTable, recordId: editingBom.id });
        message.success("更新成功");
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: bomTable,
        };
        const data = await logWithTiming("新增BOM", "INSERT", async () => {
          const { data, error } = await supabase
            .from(bomTable)
            .insert([values])
            .select()
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          return data;
        }, logParams);
        setSelectedBom(data);
        message.success("新增成功");
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingBom(null);
      fetchBoms();
    } catch (error) {
      console.error("Error saving bom:", error);
      message.error("保存失败");
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedBom) {
        message.error("请先选择BOM");
        return;
      }

      // 验证物料不能与 BOM 主档相同
      if (values.material_id === selectedBom.product_id) {
        message.error('子项物料不能与 BOM 主档物料相同');
        return;
      }

      if (editingDetail) {
        await supabase
          .from("erp_bom_details_s_539dcf81_b")
          .update(values)
          .eq("id", editingDetail.id);
        message.success("更新成功");
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map(d => d.line_no || 0)) : 0;
        values.bom_id = selectedBom.id;
        values.line_no = maxLineNo + 1;
        values.is_deleted = "n";

        const { error } = await supabase
          .from("erp_bom_details_s_539dcf81_b")
          .insert([values]);
        if (error) throw error;
        message.success("新增成功");
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(selectedBom.id);
    } catch (error) {
      console.error("Error saving detail:", error);
      message.error("保存失败");
    }
  };

  const handleEdit = async (record: Bom) => {
    setEditingBom(record);
    setSelectedBom(record);
    form.setFieldsValue({
      ...record,
      effective_date: dayjs(record.effective_date),
      expiry_date: dayjs(record.expiry_date),
      is_default: record.is_default ?? true,
      is_active: record.is_active ?? true,
    });
    await fetchDetails(record.id);
    setIsModalOpen(true);
  };

  const handleViewTree = (record: Bom) => {
    const product = products.find((p) => p.id === record.product_id);
    if (!product?.code) {
      message.warning('当前BOM没有可用的物料编码');
      return;
    }

    setTreeMaterialCode(product.code);
    setTreeDrawerOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: "确认删除",
      content: "确定要删除该BOM吗？",
      onOk: async () => {
        try {
          await logWithTiming("删除BOM", "DELETE", async () => {
            const { error } = await supabase
              .from(bomTable)
              .update({ is_deleted: "y" })
              .eq("id", id);
            if (error) throw error;
            const { error: detailError } = await supabase
              .from(bomDetailTable)
              .update({ is_deleted: "y" })
              .eq("bom_id", id);
            if (detailError) throw detailError;
          }, { table: bomTable, recordId: id });
          message.success("删除成功");
          fetchBoms();
        } catch (error) {
          console.error("Error deleting bom:", error);
          message.error("删除失败");
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingBom(null);
    setSelectedBom(null);
    setDetails([]);
    form.setFieldsValue({
      bom_no: "",
      product_id: undefined,
      version: "1.0",
      quantity: 1,
      unit: "PCS",
      is_default: true,
      is_active: true,
      effective_date: dayjs(new Date()),
      expiry_date: "",
      remark: "",
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = (e: any) => {
    e.preventDefault();
    setEditingDetail(null);
    detailForm.setFieldsValue({
      line_no: details.length + 1,
      material_id: undefined,
      quantity: 0,
      unit: "",
      loss_rate: 0,
      operation_id: undefined,
      remark: "",
    });
    setIsDetailModalOpen(true);
  };

  const handleMaterialChange = (materialId: number) => {
    const unit = getMaterialUnit(materialId);
    detailForm.setFieldValue('unit', unit);
    
    // 验证物料不能与 BOM 主档相同
    if (selectedBom && materialId === selectedBom.product_id) {
      message.error('子项物料不能与 BOM 主档物料相同');
      detailForm.setFieldValue('material_id', undefined);
      detailForm.setFieldValue('unit', '');
    }
  };

  const handleEditDetail = (record: BomDetail) => {
    setEditingDetail(record);
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: "确认删除",
      content: "确定要删除该子项吗？",
      onOk: async () => {
        try {
          await supabase
            .from("erp_bom_details_s_539dcf81_b")
            .update({ is_deleted: "y" })
            .eq("id", id);
          message.success("删除成功");
          if (selectedBom) {
            fetchDetails(selectedBom.id);
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

  const getMaterialName = (materialId: number | null) => {
    const product = allProducts.find((p) => p.id === materialId);
    return product?.name || "-";
  };

  const getMaterialUnit = (materialId: number | null) => {
    const product = allProducts.find((p) => p.id === materialId);
    return product?.unit || "";
  };

  const getOperationName = (operationId: number | null) => {
    const operation = operations.find((o) => o.id === operationId);
    return operation?.name || "-";
  };

  const filteredBoms = boms.filter(
    (b) =>
      b.bom_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductName(b.product_id)
        .toLowerCase()
        .includes(searchTerm.toLowerCase()),
  );

  const columns = [
    {
      title: "BOM编号",
      dataIndex: "bom_no",
      key: "bom_no",
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
      title: "数量",
      dataIndex: "quantity",
      key: "quantity",
    },
    {
      title: "单位",
      dataIndex: "unit",
      key: "unit",
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
      render: (_: any, record: Bom) => (
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
            onClick={() => handleViewTree(record)}
          >
            结构图
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
      title: "行号",
      dataIndex: "line_no",
      key: "line_no",
    },
    {
      title: "物料",
      dataIndex: "material_id",
      key: "material_id",
      render: (materialId: number) => getMaterialName(materialId),
    },
    {
      title: "数量",
      dataIndex: "quantity",
      key: "quantity",
    },
    {
      title: "单位",
      dataIndex: "unit",
      key: "unit",
    },
    {
      title: "损耗率",
      dataIndex: "loss_rate",
      key: "loss_rate",
      render: (rate: number) => (rate ? (rate * 100).toFixed(2) + "%" : "0%"),
    },
    {
      title: "工序",
      dataIndex: "operation_id",
      key: "operation_id",
      render: (operationId: number) => getOperationName(operationId),
    },
    {
      title: "备注",
      dataIndex: "remark",
      key: "remark",
      render: (text: string) => text || "-",
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: BomDetail) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            编辑
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      className='mainContent'
      variant="borderless"
      title="BOM管理"
      style={{ borderRadius: 0 }}
      extra={
        <Space>
          <Input.Search
            placeholder="搜索BOM编号或产品..."
            allowClear
            onSearch={(value) => {
              setSearchTerm(value);
              fetchBoms();
            }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增BOM
          </Button>
        </Space>
      }
    >
      <Table
        columns={columns}
        dataSource={filteredBoms}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <SupaModal
        title={editingBom ? "编辑BOM" : "新增BOM"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingBom(null);
          setSelectedBom(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
        width={"60%"}
        height={680}
        headerPanelTitle="BOM主档"
        detailPanelTitle="子项明细"
        historyTable={bomTable}
        historyRecordId={editingBom?.id || selectedBom?.id}
        form={form}
        formEle={
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSubmit}
            style={{ marginRight: 16 }}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="BOM编号"
                  name="bom_no"
                  rules={[{ required: true, message: "请输入BOM编号" }]}
                >
                  <Input placeholder="请输入BOM编号" disabled={!!editingBom} />
                </Form.Item>
                <Form.Item
                  label="产品"
                  name="product_id"
                  rules={[{ required: true, message: "请选择产品" }]}
                >
                  <Select
                    placeholder="请选择产品"
                    disabled={!!editingBom}
                    onChange={(value) => {
                      const product = products.find((p) => p.id === value);
                      if (product) {
                        form.setFieldValue(
                          "bom_no",
                          product.code || `BOM-${value}`,
                        );
                      }
                    }}
                  >
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
                <Form.Item label="数量" name="quantity" initialValue={1}>
                  <InputNumber
                    style={{ width: "100%" }}
                    placeholder="请输入数量"
                  />
                </Form.Item>
                <Form.Item label="单位" name="unit" initialValue="PCS">
                  <DictSelect
                    dictType="uom"
                    placeholder="请输入单位"
                    allowClear
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="生效日期" name="effective_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label="失效日期" name="expiry_date">
                  <DatePicker style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item label="备注" name="remark">
                  <Input.TextArea rows={2} placeholder="请输入备注" />
                </Form.Item>
                <Form.Item
                  label="启用"
                  name="is_active"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
                </Form.Item>
                <Form.Item
                  label="设为默认BOM"
                  name="is_default"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Checkbox />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        detailExtra={
          <Button
            type="link"
            size="small"
            onClick={handleAddDetail}
            icon={<PlusOutlined />}
          >
            新增子项
          </Button>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
          />
        }
      ></SupaModal>

      <Modal
        title={editingDetail ? "编辑BOM子项" : "新增BOM子项"}
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
        width={800}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="行号"
                name="line_no"
                rules={[{ required: true, message: "请输入行号" }]}
              >
                <InputNumber
                  min={1}
                  style={{ width: "100%" }}
                  placeholder="请输入行号"
                />
              </Form.Item>
              <Form.Item
                label="物料"
                name="material_id"
                rules={[{ required: true, message: "请选择物料" }]}
              >
                <Select
                  placeholder="请选择物料"
                  onChange={handleMaterialChange}
                >
                  {allProducts.map((p) => (
                    <Option
                      key={p.id}
                      value={p.id}
                      disabled={selectedBom && p.id === selectedBom.product_id}
                    >
                      {p.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="数量" name="quantity" initialValue={0}>
                <InputNumber
                  min={0}
                  step={0.000001}
                  precision={6}
                  style={{ width: "100%" }}
                  placeholder="请输入数量"
                />
              </Form.Item>
              <Form.Item label="单位" name="unit">
                <DictSelect
                  dictType="uom"
                  placeholder="请选择单位"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="损耗率" name="loss_rate" initialValue={0}>
                <InputNumber
                  min={0}
                  max={1}
                  step={0.0001}
                  precision={4}
                  style={{ width: "100%" }}
                  placeholder="请输入损耗率"
                />
              </Form.Item>
              <Form.Item label="工序" name="operation_id">
                <Select placeholder="请选择工序" allowClear>
                  {operations.map((o) => (
                    <Option key={o.id} value={o.id}>
                      {o.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="备注" name="remark">
                <Input.TextArea rows={3} placeholder="请输入备注" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Drawer
        title="BOM结构图"
        open={treeDrawerOpen}
        onClose={() => {
          setTreeDrawerOpen(false);
          setTreeMaterialCode(null);
        }}
        size="95%"
        destroyOnHidden
      >
        <BomEditableTreeGraph materialCode={treeMaterialCode} />
      </Drawer>
    </Card>
  );
}

