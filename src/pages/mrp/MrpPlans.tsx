import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message,DatePicker } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EyeOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import dayjs from 'dayjs';

type MrpPlan = Tables['erp_mrp_plans_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

export function MrpPlans() {
  const [plans, setPlans] = useState<MrpPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchPlans();
  }, []);

  const fetchPlans = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_mrp_plans_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('plan_date', { ascending: false });

      if (error) throw error;
      setPlans(data || []);
    } catch (error) {
      console.error('Error fetching plans:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const { error } = await supabase
        .from('erp_mrp_plans_s_539dcf81_b')
        .insert([values]);
      if (error) throw error;
      message.success('新增成功');
      setIsModalOpen(false);
      form.resetFields();
      fetchPlans();
    } catch (error) {
      console.error('Error saving plan:', error);
      message.error('保存失败');
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该计划吗？',
      onOk: async () => {
        try {
          const { error } = await supabase
            .from('erp_mrp_plans_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success('删除成功');
          fetchPlans();
        } catch (error) {
          console.error('Error deleting plan:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleRunMrp = async (id: number) => {
    Modal.confirm({
      title: '确认运行',
      content: '确定要运行MRP计算吗？',
      onOk: async () => {
        try {
          const { error } = await supabase
            .from('erp_mrp_plans_s_539dcf81_b')
            .update({ status: 'running' })
            .eq('id', id);
          if (error) throw error;
          message.success('MRP计算已开始');
          fetchPlans();
        } catch (error) {
          console.error('Error running MRP:', error);
          message.error('运行失败');
        }
      },
    });
  };

  const handleAdd = () => {
    form.setFieldsValue({
      plan_no: `MRP${Date.now().toString().slice(-8)}`,
      plan_date: dayjs(new Date()),
      start_date: '',
      end_date: '',
      plan_type: 'master',
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const filteredPlans = plans.filter(
    (p) =>
      p.plan_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.remark && p.remark.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const typeLabels: Record<string, string> = {
    master: '主生产计划',
    material: '物料需求计划',
    capacity: '产能计划',
    procurement: '采购计划',
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: '草稿', color: 'default' },
    running: { text: '计算中', color: 'processing' },
    completed: { text: '已完成', color: 'success' },
    cancelled: { text: '已取消', color: 'error' },
  };

  const columns = [
    {
      title: '计划号',
      dataIndex: 'plan_no',
      key: 'plan_no',
    },
    {
      title: '计划日期',
      dataIndex: 'plan_date',
      key: 'plan_date',
    },
    {
      title: '开始日期',
      dataIndex: 'start_date',
      key: 'start_date',
      render: (text: string) => text || '-',
    },
    {
      title: '结束日期',
      dataIndex: 'end_date',
      key: 'end_date',
      render: (text: string) => text || '-',
    },
    {
      title: '类型',
      dataIndex: 'plan_type',
      key: 'plan_type',
      render: (type: string) => typeLabels[type] || type,
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
      render: (_: any, record: MrpPlan) => (
        <Space size="middle">
          <Button type="text" icon={<EyeOutlined />}>
            查看
          </Button>
          {record.status === 'draft' && (
            <Button type="text" icon={<PlayCircleOutlined />} onClick={() => handleRunMrp(record.id)}>
              运行
            </Button>
          )}
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title="MRP计划管理" extra={
      <Space>
        <Input
          placeholder="搜索计划号..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增计划</Button>
      </Space>
    }>
      <Table
        columns={columns}
        dataSource={filteredPlans}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title="新增MRP计划"
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
            label="计划号"
            name="plan_no"
            rules={[{ required: true, message: '请输入计划号' }]}
          >
            <Input placeholder="请输入计划号" />
          </Form.Item>
          <Form.Item label="计划类型" name="plan_type" initialValue="master">
            <Select>
              <Option value="master">主生产计划</Option>
              <Option value="material">物料需求计划</Option>
              <Option value="capacity">产能计划</Option>
              <Option value="procurement">采购计划</Option>
            </Select>
          </Form.Item>
          <Form.Item label="计划日期" name="plan_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="开始日期" name="start_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="结束日期" name="end_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <TextArea rows={3} placeholder="请输入备注" />
          </Form.Item>
          <Form.Item label="状态" name="status" initialValue="draft">
            <Select>
              <Option value="draft">草稿</Option>
              <Option value="running">计算中</Option>
              <Option value="completed">已完成</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
