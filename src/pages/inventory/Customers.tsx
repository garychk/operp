import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, Row, Col, InputNumber } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';

type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];

const { Option } = Select;

export function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchCustomers();
  }, []);

  const fetchCustomers = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_customers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error fetching customers:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingCustomer) {
        await logWithTiming('更新客户', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_customers_s_539dcf81_b')
            .update(values)
            .eq('id', editingCustomer.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增客户', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_customers_s_539dcf81_b')
            .insert([values]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingCustomer(null);
      fetchCustomers();
    } catch (error) {
      console.error('Error saving customer:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: Customer) => {
    setEditingCustomer(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该客户吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除客户', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_customers_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchCustomers();
        } catch (error) {
          console.error('Error deleting customer:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingCustomer(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const typeLabels: Record<string, string> = {
    enterprise: '企业',
    individual: '个人',
    government: '政府',
    other: '其他',
  };

  const levelLabels: Record<string, string> = {
    vip: 'VIP',
    important: '重要',
    normal: '普通',
    potential: '潜在',
  };

  const columns = [
    {
      title: '客户编码',
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: '客户名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: '等级',
      dataIndex: 'level',
      key: 'level',
      render: (level: string) => levelLabels[level] || level,
    },
    {
      title: '联系人',
      dataIndex: 'contact_name',
      key: 'contact_name',
      render: (text: string) => text || '-',
    },
    {
      title: '联系电话',
      dataIndex: 'contact_phone',
      key: 'contact_phone',
      render: (text: string) => text || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? '启用' : '停用'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: Customer) => (
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
    <Card variant="borderless" title="客户管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增客户</Button>}>      

      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索客户名称或编码..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredCustomers}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingCustomer ? '编辑客户' : '新增客户'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingCustomer(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="客户编码"
                name="code"
                rules={[{ required: true, message: '请输入客户编码' }]}
              >
                <Input placeholder="请输入客户编码" disabled={!!editingCustomer} />
              </Form.Item>
              <Form.Item
                label="客户名称"
                name="name"
                rules={[{ required: true, message: '请输入客户名称' }]}
              >
                <Input placeholder="请输入客户名称" />
              </Form.Item>
              <Form.Item label="简称" name="short_name">
                <Input placeholder="请输入简称" />
              </Form.Item>
              <Form.Item label="类型" name="type" initialValue="enterprise">
                <Select>
                  <Option value="enterprise">企业</Option>
                  <Option value="individual">个人</Option>
                  <Option value="government">政府</Option>
                  <Option value="other">其他</Option>
                </Select>
              </Form.Item>
              <Form.Item label="等级" name="level" initialValue="normal">
                <Select>
                  <Option value="vip">VIP</Option>
                  <Option value="important">重要</Option>
                  <Option value="normal">普通</Option>
                  <Option value="potential">潜在</Option>
                </Select>
              </Form.Item>
              <Form.Item label="联系人" name="contact_name">
                <Input placeholder="请输入联系人" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="联系电话" name="contact_phone">
                <Input placeholder="请输入联系电话" />
              </Form.Item>
              <Form.Item label="地址" name="address">
                <Input placeholder="请输入地址" />
              </Form.Item>
              <Form.Item label="税号" name="tax_no">
                <Input placeholder="请输入税号" />
              </Form.Item>
              <Form.Item label="信用额度" name="credit_limit" initialValue={0}>
                <InputNumber placeholder="请输入信用额度" />
              </Form.Item>
              <Form.Item label="状态" name="status" initialValue="active">
                <Select>
                  <Option value="active">启用</Option>
                  <Option value="inactive">停用</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Card>
  );
}
