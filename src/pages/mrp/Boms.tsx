import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber, Checkbox } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';

type Bom = Tables['erp_boms_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];

const { Option } = Select;

export function Boms() {
  const [boms, setBoms] = useState<Bom[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingBom, setEditingBom] = useState<Bom | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchBoms();
    fetchProducts();
  }, []);

  const fetchBoms = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_boms_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setBoms(data || []);
    } catch (error) {
      console.error('Error fetching boms:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_products_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('is_manufactured', true);
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error fetching products:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingBom) {
        await logWithTiming('更新BOM', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_boms_s_539dcf81_b')
            .update(values)
            .eq('id', editingBom.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增BOM', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_boms_s_539dcf81_b')
            .insert([values]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingBom(null);
      fetchBoms();
    } catch (error) {
      console.error('Error saving bom:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: Bom) => {
    setEditingBom(record);
    form.setFieldsValue({
      ...record,
      is_default: record.is_default ?? true,
      is_active: record.is_active ?? true,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该BOM吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除BOM', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_boms_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchBoms();
        } catch (error) {
          console.error('Error deleting bom:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingBom(null);
    form.setFieldsValue({
      bom_no: '',
      product_id: undefined,
      version: '1.0',
      quantity: 1,
      unit: '件',
      is_default: true,
      is_active: true,
      effective_date: new Date().toISOString().split('T')[0],
      expiry_date: '',
      remark: '',
    });
    setIsModalOpen(true);
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || '-';
  };

  const filteredBoms = boms.filter(
    (b) =>
      b.bom_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductName(b.product_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const columns = [
    {
      title: 'BOM编号',
      dataIndex: 'bom_no',
      key: 'bom_no',
    },
    {
      title: '产品',
      dataIndex: 'product_id',
      key: 'product_id',
      render: (productId: number) => getProductName(productId),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
    },
    {
      title: '单位',
      dataIndex: 'unit',
      key: 'unit',
    },
    {
      title: '默认',
      dataIndex: 'is_default',
      key: 'is_default',
      render: (isDefault: boolean) => (isDefault ? '是' : '否'),
    },
    {
      title: '状态',
      dataIndex: 'is_active',
      key: 'is_active',
      render: (isActive: boolean) => (
        <Tag color={isActive ? 'success' : 'default'}>
          {isActive ? '启用' : '停用'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: Bom) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title="BOM管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增BOM</Button>}>      
      
      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索BOM编号或产品..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredBoms}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingBom ? '编辑BOM' : '新增BOM'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingBom(null);
        }}
        footer={null}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label="BOM编号"
            name="bom_no"
            rules={[{ required: true, message: '请输入BOM编号' }]}
          >
            <Input placeholder="请输入BOM编号" disabled={!!editingBom} />
          </Form.Item>
          <Form.Item
            label="产品"
            name="product_id"
            rules={[{ required: true, message: '请选择产品' }]}
          >
            <Select placeholder="请选择产品" disabled={!!editingBom}>
              {products.map((p) => (
                <Option key={p.id} value={p.id}>{p.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="版本" name="version" initialValue="1.0">
            <Input placeholder="请输入版本" />
          </Form.Item>
          <Form.Item label="数量" name="quantity" initialValue={1}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入数量" />
          </Form.Item>
          <Form.Item label="单位" name="unit" initialValue="件">
            <Input placeholder="请输入单位" />
          </Form.Item>
          <Form.Item label="设为默认BOM" name="is_default" valuePropName="checked" initialValue={true}>
            <Checkbox />
          </Form.Item>
          <Form.Item label="生效日期" name="effective_date">
            <Input type="date" />
          </Form.Item>
          <Form.Item label="失效日期" name="expiry_date">
            <Input type="date" />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} placeholder="请输入备注" />
          </Form.Item>
          <Form.Item label="启用" name="is_active" valuePropName="checked" initialValue={true}>
            <Checkbox />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setIsModalOpen(false)}>取消</Button>
              <Button type="primary" htmlType="submit">
                保存
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
