import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber, Row, Col } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';

type FixedAsset = Tables['erp_fixed_assets_s_539dcf81_b']['Row'];
type AssetCategory = Tables['erp_asset_categories_s_539dcf81_b']['Row'];

const { Option } = Select;

export function FixedAssets() {
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<FixedAsset | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchAssets();
    fetchCategories();
  }, []);

  const fetchAssets = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_fixed_assets_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setAssets(data || []);
    } catch (error) {
      console.error('Error fetching assets:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_asset_categories_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setCategories(data || []);
    } catch (error) {
      console.error('Error fetching categories:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingAsset) {
        await logWithTiming('更新固定资产', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_fixed_assets_s_539dcf81_b')
            .update(values)
            .eq('id', editingAsset.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增固定资产', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_fixed_assets_s_539dcf81_b')
            .insert([{
              ...values,
              accumulated_depreciation: 0,
              net_value: values.original_value,
            }]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingAsset(null);
      fetchAssets();
    } catch (error) {
      console.error('Error saving asset:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: FixedAsset) => {
    setEditingAsset(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该资产吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除固定资产', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_fixed_assets_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchAssets();
        } catch (error) {
          console.error('Error deleting asset:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingAsset(null);
    form.setFieldsValue({
      asset_no: '',
      asset_name: '',
      category_id: undefined,
      model: '',
      quantity: 1,
      unit: '台',
      purchase_date: new Date().toISOString().split('T')[0],
      purchase_price: 0,
      original_value: 0,
      depreciation_method: 'straight_line',
      useful_life_months: 60,
      residual_rate: 5,
      location: '',
      status: 'in_use',
    });
    setIsModalOpen(true);
  };

  const getCategoryName = (categoryId: number | null) => {
    const category = categories.find((c) => c.id === categoryId);
    return category?.name || '-';
  };

  const filteredAssets = assets.filter(
    (a) =>
      a.asset_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.asset_name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    in_use: { text: '使用中', color: 'success' },
    idle: { text: '闲置', color: 'warning' },
    scrapped: { text: '报废', color: 'default' },
    transferred: { text: '已转移', color: 'processing' },
  };

  const columns = [
    {
      title: '资产编号',
      dataIndex: 'asset_no',
      key: 'asset_no',
    },
    {
      title: '资产名称',
      dataIndex: 'asset_name',
      key: 'asset_name',
    },
    {
      title: '类别',
      dataIndex: 'category_id',
      key: 'category_id',
      render: (categoryId: number) => getCategoryName(categoryId),
    },
    {
      title: '购置日期',
      dataIndex: 'purchase_date',
      key: 'purchase_date',
    },
    {
      title: '原值',
      dataIndex: 'original_value',
      key: 'original_value',
      render: (value: number) => `¥${(value ?? 0).toLocaleString()}`,
    },
    {
      title: '净值',
      dataIndex: 'net_value',
      key: 'net_value',
      render: (value: number) => `¥${(value ?? 0).toLocaleString()}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: FixedAsset) => (
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
    <Card variant="borderless" title="固定资产管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增资产</Button>}>

      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索资产编号或名称..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredAssets}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingAsset ? '编辑固定资产' : '新增固定资产'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingAsset(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => form.submit()}>
            保存
          </Button>
        </Space>}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="资产编号"
                name="asset_no"
                rules={[{ required: true, message: '请输入资产编号' }]}
              >
                <Input placeholder="请输入资产编号" disabled={!!editingAsset} />
              </Form.Item>
              <Form.Item
                label="资产名称"
                name="asset_name"
                rules={[{ required: true, message: '请输入资产名称' }]}
              >
                <Input placeholder="请输入资产名称" />
              </Form.Item>
              <Form.Item
                label="类别"
                name="category_id"
                rules={[{ required: true, message: '请选择类别' }]}
              >
                <Select placeholder="请选择类别">
                  {categories.map((c) => (
                    <Option key={c.id} value={c.id}>{c.name}</Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label="规格型号" name="model">
                <Input placeholder="请输入规格型号" />
              </Form.Item>
              <Form.Item label="数量" name="quantity" initialValue={1}>
                <InputNumber style={{ width: '100%' }} placeholder="请输入数量" />
              </Form.Item>
              <Form.Item label="单位" name="unit" initialValue="台">
                <Input placeholder="请输入单位" />
              </Form.Item>
              <Form.Item label="购置日期" name="purchase_date">
                <Input type="date" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="采购价格" name="purchase_price" initialValue={0}>
                <InputNumber style={{ width: '100%' }} placeholder="请输入采购价格" />
              </Form.Item>
              <Form.Item label="原值" name="original_value" initialValue={0}>
                <InputNumber style={{ width: '100%' }} placeholder="请输入原值" />
              </Form.Item>
              <Form.Item label="折旧方法" name="depreciation_method" initialValue="straight_line">
                <Select>
                  <Option value="straight_line">直线法</Option>
                  <Option value="double_declining">双倍余额递减法</Option>
                  <Option value="sum_of_years">年数总和法</Option>
                </Select>
              </Form.Item>
              <Form.Item label="使用年限(月)" name="useful_life_months" initialValue={60}>
                <InputNumber style={{ width: '100%' }} placeholder="请输入使用年限" />
              </Form.Item>
              <Form.Item label="残值率(%)" name="residual_rate" initialValue={5}>
                <InputNumber style={{ width: '100%' }} placeholder="请输入残值率" />
              </Form.Item>
              <Form.Item label="存放地点" name="location">
                <Input placeholder="请输入存放地点" />
              </Form.Item>
              <Form.Item label="状态" name="status" initialValue="in_use">
                <Select>
                  <Option value="in_use">使用中</Option>
                  <Option value="idle">闲置</Option>
                  <Option value="scrapped">报废</Option>
                  <Option value="transferred">已转移</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
