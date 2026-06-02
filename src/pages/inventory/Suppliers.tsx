import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, Row, Col, InputNumber } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';
import SupaModal from '../../components/SupaModal';

type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];

const { Option } = Select;

export function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchSuppliers();
  }, []);

  const fetchSuppliers = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_suppliers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setSuppliers(data || []);
    } catch (error) {
      console.error('Error fetching suppliers:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingSupplier) {
        await logWithTiming('更新供应商', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_suppliers_s_539dcf81_b')
            .update(values)
            .eq('id', editingSupplier.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        const { error } = await supabase
          .from('erp_suppliers_s_539dcf81_b')
          .insert([values]);
        if (error) throw error;
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingSupplier(null);
      fetchSuppliers();
    } catch (error) {
      console.error('Error saving supplier:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: Supplier) => {
    setEditingSupplier(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该供应商吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除供应商', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_suppliers_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchSuppliers();
        } catch (error) {
          console.error('Error deleting supplier:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingSupplier(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const filteredSuppliers = suppliers.filter(
    (s) =>
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const typeLabels: Record<string, string> = {
    manufacturer: '制造商',
    distributor: '经销商',
    retailer: '零售商',
    service: '服务商',
    other: '其他',
  };

  const levelLabels: Record<string, string> = {
    strategic: '战略',
    preferred: '优先',
    normal: '普通',
    potential: '潜在',
  };

  const columns = [
    {
      title: '供应商编码',
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: '供应商名称',
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
      render: (_: any, record: Supplier) => (
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
    <Card variant="borderless" title="供应商管理" extra={
      <Space>
        <Input
          placeholder="搜索供应商名称或编码..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增供应商</Button>
      </Space>
    }>      
      <Table
        columns={columns}
        dataSource={filteredSuppliers}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <SupaModal
        title={editingSupplier ? '编辑供应商' : '新增供应商'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingSupplier(null);
        }}
        width={800}
        height={660}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        }
      >
        <Card>
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginRight: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label="供应商编码"
                name="code"
                rules={[{ required: true, message: '请输入供应商编码' }]}
              >
                <Input placeholder="请输入供应商编码" disabled={!!editingSupplier} />
              </Form.Item>
              <Form.Item
                label="供应商名称"
                name="name"
                rules={[{ required: true, message: '请输入供应商名称' }]}
              >
                <Input placeholder="请输入供应商名称" />
              </Form.Item>
              <Form.Item label="简称" name="short_name">
                <Input placeholder="请输入简称" />
              </Form.Item>
              <Form.Item label="类型" name="type" initialValue="manufacturer">
                <Select>
                  <Option value="manufacturer">制造商</Option>
                  <Option value="distributor">经销商</Option>
                  <Option value="retailer">零售商</Option>
                  <Option value="service">服务商</Option>
                  <Option value="other">其他</Option>
                </Select>
              </Form.Item>
              <Form.Item label="等级" name="level" initialValue="normal">
                <Select>
                  <Option value="strategic">战略</Option>
                  <Option value="preferred">优先</Option>
                  <Option value="normal">普通</Option>
                  <Option value="potential">潜在</Option>
                </Select>
              </Form.Item>
              <Form.Item label="联系人" name="contact_name">
                <Input placeholder="请输入联系人" />
              </Form.Item>
              <Form.Item label="联系电话" name="contact_phone">
                <Input placeholder="请输入联系电话" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="地址" name="address">
                <Input placeholder="请输入地址" />
              </Form.Item>
              <Form.Item label="税号" name="tax_no">
                <Input placeholder="请输入税号" />
              </Form.Item>
              <Form.Item label="开户银行" name="bank_name">
                <Input placeholder="请输入开户银行" />
              </Form.Item>
              <Form.Item label="银行账号" name="bank_account">
                <Input placeholder="请输入银行账号" />
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
        </Card>
      </SupaModal>
    </Card>
  );
}
