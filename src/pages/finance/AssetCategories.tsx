import { useEffect, useState } from 'react';
import { Button, Input, Table, Modal, Form, Select, Space, Card, message, InputNumber } from 'antd';
import { PlusOutlined, SearchOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';

type AssetCategory = Tables['erp_asset_categories_s_539dcf81_b']['Row'];

const { Option } = Select;

export function AssetCategories() {
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<AssetCategory | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_asset_categories_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('code');

      if (error) throw error;
      setCategories(data || []);
    } catch (error) {
      console.error('Error fetching categories:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingCategory) {
        const { error } = await supabase
          .from('erp_asset_categories_s_539dcf81_b')
          .update(values)
          .eq('id', editingCategory.id);
        if (error) throw error;
        message.success('更新成功');
      } else {
        const { error } = await supabase
          .from('erp_asset_categories_s_539dcf81_b')
          .insert([values]);
        if (error) throw error;
        message.success('新增成功');
      }
      setIsModalOpen(false);
      setEditingCategory(null);
      form.resetFields();
      fetchCategories();
    } catch (error) {
      console.error('Error saving category:', error);
      message.error('保存失败');
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该类别吗？',
      onOk: async () => {
        try {
          const { error } = await supabase
            .from('erp_asset_categories_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success('删除成功');
          fetchCategories();
        } catch (error) {
          console.error('Error deleting category:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleEdit = (category: AssetCategory) => {
    setEditingCategory(category);
    form.setFieldsValue({
      code: category.code,
      name: category.name,
      parent_id: category.parent_id,
      depreciation_method: category.depreciation_method || 'straight_line',
      useful_life_months: category.useful_life_months || 60,
      residual_rate: category.residual_rate || 5,
      subject_id: category.subject_id,
    });
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingCategory(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const filteredCategories = categories.filter(
    (c) =>
      c.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getParentName = (parentId: number | null) => {
    if (!parentId) return '-';
    const parent = categories.find((c) => c.id === parentId);
    return parent?.name || '-';
  };

  const depreciationMethodLabels: Record<string, string> = {
    straight_line: '直线法',
    double_declining: '双倍余额递减法',
    sum_of_years: '年数总和法',
  };

  const columns = [
    {
      title: '类别代码',
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: '类别名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '上级类别',
      dataIndex: 'parent_id',
      key: 'parent_id',
      render: (parentId: number | null) => getParentName(parentId),
    },
    {
      title: '折旧方法',
      dataIndex: 'depreciation_method',
      key: 'depreciation_method',
      render: (method: string | null) => depreciationMethodLabels[method || ''] || '-',
    },
    {
      title: '使用年限(月)',
      dataIndex: 'useful_life_months',
      key: 'useful_life_months',
      render: (months: number | null) => months || '-',
    },
    {
      title: '残值率(%)',
      dataIndex: 'residual_rate',
      key: 'residual_rate',
      render: (rate: number | null) => rate || '-',
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: AssetCategory) => (
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
    <Card className='mainContent' variant="borderless" title="资产类别管理" extra={<Space>
      <Input
        placeholder="搜索类别代码或名称..."
        prefix={<SearchOutlined />}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
      <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增类别</Button>
    </Space>}>

      <Table
        columns={columns}
        dataSource={filteredCategories}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingCategory ? '编辑类别' : '新增类别'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingCategory(null);
          form.resetFields();
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => form.submit()}>
            保存
          </Button>
        </Space>}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label="类别代码"
            name="code"
            rules={[{ required: true, message: '请输入类别代码' }]}
          >
            <Input placeholder="请输入类别代码" />
          </Form.Item>
          <Form.Item
            label="类别名称"
            name="name"
            rules={[{ required: true, message: '请输入类别名称' }]}
          >
            <Input placeholder="请输入类别名称" />
          </Form.Item>
          <Form.Item label="上级类别" name="parent_id">
            <Select placeholder="请选择上级类别">
              <Option value={null}>无</Option>
              {categories.filter((c) => c.id !== editingCategory?.id).map((c) => (
                <Option key={c.id} value={c.id}>{c.name}</Option>
              ))}
            </Select>
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
        </Form>
      </Modal>
    </Card>
  );
}

