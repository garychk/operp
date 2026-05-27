import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber, DatePicker } from 'antd';
import { PlusOutlined, SearchOutlined, EyeOutlined, DeleteOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import dayjs from 'dayjs';

type Voucher = Tables['erp_vouchers_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

export function Vouchers() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchVouchers();
  }, []);

  const fetchVouchers = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_vouchers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('voucher_date', { ascending: false });

      if (error) throw error;
      setVouchers(data || []);
    } catch (error) {
      console.error('Error fetching vouchers:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const { error } = await supabase
        .from('erp_vouchers_s_539dcf81_b')
        .insert([values]);
      if (error) throw error;
      message.success('新增成功');
      setIsModalOpen(false);
      form.resetFields();
      fetchVouchers();
    } catch (error) {
      console.error('Error saving voucher:', error);
      message.error('保存失败');
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该凭证吗？',
      onOk: async () => {
        try {
          const { error } = await supabase
            .from('erp_vouchers_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success('删除成功');
          fetchVouchers();
        } catch (error) {
          console.error('Error deleting voucher:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    form.setFieldsValue({
      voucher_no: `PZ${Date.now().toString().slice(-8)}`,
      voucher_date: dayjs(new Date()),
      type: 'general',
      total_amount: 0,
      remark: '',
    });
    setIsModalOpen(true);
  };

  const filteredVouchers = vouchers.filter(
    (v) =>
      v.voucher_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (v.remark && v.remark.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const typeLabels: Record<string, string> = {
    general: '记账凭证',
    receipt: '收款凭证',
    payment: '付款凭证',
    transfer: '转账凭证',
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: '草稿', color: 'warning' },
    posted: { text: '已过账', color: 'success' },
    cancelled: { text: '已作废', color: 'error' },
  };

  const columns = [
    {
      title: '凭证号',
      dataIndex: 'voucher_no',
      key: 'voucher_no',
    },
    {
      title: '日期',
      dataIndex: 'voucher_date',
      key: 'voucher_date',
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: '金额',
      dataIndex: 'total_amount',
      key: 'total_amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: '摘要',
      dataIndex: 'remark',
      key: 'remark',
      render: (text: string) => text || '-',
      ellipsis: true,
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
      render: (_: any, record: Voucher) => (
        <Space size="middle">
          <Button type="text" icon={<EyeOutlined />}>
            查看
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title="凭证管理" extra={
      <Space>
        <Input
          placeholder="搜索凭证号或摘要..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增凭证</Button>
      </Space>
    }>
      <Table
        columns={columns}
        dataSource={filteredVouchers}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title="新增凭证"
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
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
            label="凭证号"
            name="voucher_no"
            rules={[{ required: true, message: '请输入凭证号' }]}
          >
            <Input placeholder="请输入凭证号" />
          </Form.Item>
          <Form.Item
            label="日期"
            name="voucher_date"
            rules={[{ required: true, message: '请选择日期' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="类型" name="type" initialValue="general">
            <Select>
              <Option value="general">记账凭证</Option>
              <Option value="receipt">收款凭证</Option>
              <Option value="payment">付款凭证</Option>
              <Option value="transfer">转账凭证</Option>
            </Select>
          </Form.Item>
          <Form.Item label="金额" name="total_amount" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入金额" />
          </Form.Item>
          <Form.Item label="摘要" name="remark">
            <TextArea rows={3} placeholder="请输入摘要" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
