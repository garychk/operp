import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';

type Payable = Tables['erp_payables_s_539dcf81_b']['Row'];
type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];

const { Option } = Select;

export function Payables() {
  const [payables, setPayables] = useState<Payable[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPayable, setEditingPayable] = useState<Payable | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchPayables();
    fetchSuppliers();
  }, []);

  const fetchPayables = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_payables_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('doc_date', { ascending: false });

      if (error) throw error;
      setPayables(data || []);
    } catch (error) {
      console.error('Error fetching payables:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_suppliers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setSuppliers(data || []);
    } catch (error) {
      console.error('Error fetching suppliers:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingPayable) {
        await logWithTiming('更新应付账款', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_payables_s_539dcf81_b')
            .update(values)
            .eq('id', editingPayable.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增应付账款', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_payables_s_539dcf81_b')
            .insert([{
              ...values,
              balance: values.amount,
            }]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingPayable(null);
      fetchPayables();
    } catch (error) {
      console.error('Error saving payable:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: Payable) => {
    setEditingPayable(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该记录吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除应付账款', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_payables_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchPayables();
        } catch (error) {
          console.error('Error deleting payable:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingPayable(null);
    form.setFieldsValue({
      supplier_id: undefined,
      doc_type: 'invoice',
      doc_no: '',
      doc_date: new Date().toISOString().split('T')[0],
      due_date: '',
      amount: 0,
      remark: '',
    });
    setIsModalOpen(true);
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || '-';
  };

  const filteredPayables = payables.filter(
    (p) =>
      p.doc_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(p.supplier_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { text: string; color: string }> = {
    open: { text: '未结清', color: 'warning' },
    partially_paid: { text: '部分付款', color: 'processing' },
    closed: { text: '已结清', color: 'success' },
    overdue: { text: '逾期', color: 'error' },
  };

  const columns = [
    {
      title: '单据号',
      dataIndex: 'doc_no',
      key: 'doc_no',
    },
    {
      title: '供应商',
      dataIndex: 'supplier_id',
      key: 'supplier_id',
      render: (supplierId: number) => getSupplierName(supplierId),
    },
    {
      title: '单据日期',
      dataIndex: 'doc_date',
      key: 'doc_date',
    },
    {
      title: '到期日',
      dataIndex: 'due_date',
      key: 'due_date',
      render: (text: string) => text || '-',
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: '余额',
      dataIndex: 'balance',
      key: 'balance',
      render: (balance: number) => `¥${(balance ?? 0).toLocaleString()}`,
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
      render: (_: any, record: Payable) => (
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
    <Card variant="borderless" title="应付账款管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增应付</Button>}>      
      
      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索单据号或供应商..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredPayables}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingPayable ? '编辑应付账款' : '新增应付账款'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingPayable(null);
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
            label="供应商"
            name="supplier_id"
            rules={[{ required: true, message: '请选择供应商' }]}
          >
            <Select placeholder="请选择供应商">
              {suppliers.map((s) => (
                <Option key={s.id} value={s.id}>{s.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="单据类型" name="doc_type" initialValue="invoice">
            <Select>
              <Option value="invoice">发票</Option>
              <Option value="order">订单</Option>
              <Option value="other">其他</Option>
            </Select>
          </Form.Item>
          <Form.Item
            label="单据号"
            name="doc_no"
            rules={[{ required: true, message: '请输入单据号' }]}
          >
            <Input placeholder="请输入单据号" disabled={!!editingPayable} />
          </Form.Item>
          <Form.Item
            label="单据日期"
            name="doc_date"
            rules={[{ required: true, message: '请选择单据日期' }]}
          >
            <Input type="date" />
          </Form.Item>
          <Form.Item label="到期日" name="due_date">
            <Input type="date" />
          </Form.Item>
          <Form.Item
            label="金额"
            name="amount"
            rules={[{ required: true, message: '请输入金额' }]}
            initialValue={0}
          >
            <InputNumber style={{ width: '100%' }} placeholder="请输入金额" />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={3} placeholder="请输入备注" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
