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
} from "antd";
import {
  PlusOutlined,
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import { Categories } from "./Categories";
import SupaModal from "../../components/SupaModal";

type Product = Tables["erp_products_s_539dcf81_b"]["Row"];
type ProductCategory = Tables["erp_product_categories_s_539dcf81_b"]["Row"];

const { Option } = Select;
const productTable = "erp_products_s_539dcf81_b";

export function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchProducts();
    fetchCategories();
  }, []);

  const fetchProducts = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("erp_products_s_539dcf81_b")
        .select("*")
        .eq("is_deleted", "n")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error("Error fetching products:", error);
      message.error("获取数据失败");
    } finally {
      setLoading(false);
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
      if (editingProduct) {
        await logWithTiming("更新物料", "UPDATE", async () => {
          const { error } = await supabase
            .from(productTable)
            .update(values)
            .eq("id", editingProduct.id);
          if (error) throw error;
        }, { table: productTable, recordId: editingProduct.id });
        message.success("更新成功");
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: productTable,
        };
        await logWithTiming("新增物料", "INSERT", async () => {
          const { data, error } = await supabase
            .from(productTable)
            .insert([values])
            .select("id")
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
        }, logParams);
        message.success("新增成功");
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingProduct(null);
      fetchProducts();
    } catch (error) {
      console.error("Error saving product:", error);
      message.error("保存失败");
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: "确认删除",
      content: "确定要删除该物料吗？",
      onOk: async () => {
        try {
          const { error } = await supabase
            .from("erp_products_s_539dcf81_b")
            .update({ is_deleted: "y" })
            .eq("id", id);
          if (error) throw error;
          message.success("删除成功");
          fetchProducts();
        } catch (error) {
          console.error("Error deleting product:", error);
          message.error("删除失败");
        }
      },
    });
  };

  const handleEdit = (record: Product) => {
    setEditingProduct(record);
    form.setFieldsValue({
      ...record,
      is_purchased: record.is_purchased ?? true,
      is_sold: record.is_sold ?? true,
      is_manufactured: record.is_manufactured ?? false,
    });
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingProduct(null);
    form.setFieldsValue({
      code: "",
      name: "",
      short_name: "",
      category_id: undefined,
      specification: "",
      unit: "件",
      barcode: "",
      purchase_price: 0,
      sale_price: 0,
      cost_price: 0,
      safety_stock: 0,
      max_stock: 0,
      min_stock: 0,
      is_purchased: true,
      is_sold: true,
      is_manufactured: false,
      status: "active",
    });
    setIsModalOpen(true);
  };

  const getCategoryName = (categoryId: number | null) => {
    const category = categories.find((c) => c.id === categoryId);
    return category?.name || "-";
  };

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.code.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const columns = [
    {
      title: "物料编码",
      dataIndex: "code",
      key: "code",
    },
    {
      title: "物料名称",
      dataIndex: "name",
      key: "name",
    },
    {
      title: "类别",
      dataIndex: "category_id",
      key: "category_id",
      render: (categoryId: number) => getCategoryName(categoryId),
    },
    {
      title: "规格",
      dataIndex: "specification",
      key: "specification",
      render: (text: string) => text || "-",
    },
    {
      title: "单位",
      dataIndex: "unit",
      key: "unit",
    },
    {
      title: "采购价",
      dataIndex: "purchase_price",
      key: "purchase_price",
      render: (price: number) => `¥${(price ?? 0).toLocaleString()}`,
    },
    {
      title: "销售价",
      dataIndex: "sale_price",
      key: "sale_price",
      render: (price: number) => `¥${(price ?? 0).toLocaleString()}`,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (status: string) => (
        <Tag color={status === "active" ? "success" : "default"}>
          {status === "active" ? "启用" : "停用"}
        </Tag>
      ),
    },
    {
      title: "操作",
      key: "action",
      render: (_: any, record: Product) => (
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
      title="物料管理"
      extra={
        <Space>
          <Input.Search placeholder="搜索物料名称或编码..." allowClear onSearch={(value) => {
            setSearchTerm(value);
            fetchProducts();
          }} />
          <Button
            icon={<SettingOutlined />}
            onClick={() => setIsCategoryModalOpen(true)}
          >
            类别管理
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            新增物料
          </Button>
        </Space>
      }
    >
      <Table
        columns={columns}
        dataSource={filteredProducts}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <SupaModal
        title={editingProduct ? "编辑物料" : "新增物料"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingProduct(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
        width={'70%'}
        height={650}
        headerPanelTitle="物料主档"
        historyTable={productTable}
        historyRecordId={editingProduct?.id}
        form={form}
        formEle={<Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          style={{ marginRight: 16 }}
        >
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="物料编码"
                name="code"
                rules={[{ required: true, message: "请输入物料编码" }]}
              >
                <Input
                  placeholder="请输入物料编码"
                  disabled={!!editingProduct}
                />
              </Form.Item>
              <Form.Item
                label="物料名称"
                name="name"
                rules={[{ required: true, message: "请输入物料名称" }]}
              >
                <Input placeholder="请输入物料名称" />
              </Form.Item>
              <Form.Item label="简称" name="short_name">
                <Input placeholder="请输入简称" />
              </Form.Item>
              <Form.Item label="类别" name="category_id">
                <Select placeholder="请选择类别">
                  {categories.map((c) => (
                    <Option key={c.id} value={c.id}>
                      {c.name}
                    </Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="规格" name="specification">
                <Input placeholder="请输入规格" />
              </Form.Item>
              <Form.Item label="单位" name="unit" initialValue="件">
                <Input placeholder="请输入单位" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="条码" name="barcode">
                <Input placeholder="请输入条码" />
              </Form.Item>
              <Form.Item label="采购价" name="purchase_price" initialValue={0}>
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder="请输入采购价"
                />
              </Form.Item>
              <Form.Item label="销售价" name="sale_price" initialValue={0}>
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder="请输入销售价"
                />
              </Form.Item>
              <Form.Item label="成本价" name="cost_price" initialValue={0}>
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder="请输入成本价"
                />
              </Form.Item>
              <Form.Item label="安全库存" name="safety_stock" initialValue={0}>
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder="请输入安全库存"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="最大库存" name="max_stock" initialValue={0}>
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder="请输入最大库存"
                />
              </Form.Item>
              <Form.Item label="最小库存" name="min_stock" initialValue={0}>
                <InputNumber
                  style={{ width: "100%" }}
                  placeholder="请输入最小库存"
                />
              </Form.Item>
              <Form.Item
                label="可采购"
                name="is_purchased"
                valuePropName="checked"
                initialValue={true}
              >
                <Checkbox />
              </Form.Item>
              <Form.Item
                label="可销售"
                name="is_sold"
                valuePropName="checked"
                initialValue={true}
              >
                <Checkbox />
              </Form.Item>
              <Form.Item
                label="可生产"
                name="is_manufactured"
                valuePropName="checked"
                initialValue={false}
              >
                <Checkbox />
              </Form.Item>
              <Form.Item label="状态" name="status" initialValue="active">
                <Select>
                  <Option value="active">启用</Option>
                  <Option value="inactive">停用</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>}
      ></SupaModal>
      <Modal
        title="物料类别管理"
        open={isCategoryModalOpen}
        onCancel={() => setIsCategoryModalOpen(false)}
        footer={null}
        width={800}
        destroyOnClose
      >
        <Categories />
      </Modal>
    </Card>
  );
}
