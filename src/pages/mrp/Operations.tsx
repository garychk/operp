import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';

type Operation = Tables['erp_operations_s_539dcf81_b']['Row'];
type WorkCenter = Tables['erp_work_centers_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

export function Operations() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [workCenters, setWorkCenters] = useState<WorkCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingOperation, setEditingOperation] = useState<Operation | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchOperations();
    fetchWorkCenters();
  }, []);

  const fetchOperations = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_operations_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setOperations(data || []);
    } catch (error) {
      console.error('Error fetching operations:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchWorkCenters = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_work_centers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setWorkCenters(data || []);
    } catch (error) {
      console.error('Error fetching work centers:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingOperation) {
        await logWithTiming('更新工序', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_operations_s_539dcf81_b')
            .update(values)
            .eq('id', editingOperation.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增工序', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_operations_s_539dcf81_b')
            .insert([values]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingOperation(null);
      fetchOperations();
    } catch (error) {
      console.error('Error saving operation:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: Operation) => {
    setEditingOperation(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该工序吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除工序', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_operations_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchOperations();
        } catch (error) {
          console.error('Error deleting operation:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingOperation(null);
    form.setFieldsValue({
      code: '',
      name: '',
      description: '',
      work_center_id: undefined,
      standard_hours: 0,
      setup_hours: 0,
      labor_rate: 0,
      overhead_rate: 0,
      status: 'active',
    });
    setIsModalOpen(true);
  };

  const getWorkCenterName = (workCenterId: number | null) => {
    const workCenter = workCenters.find((w) => w.id === workCenterId);
    return workCenter?.name || '-';
  };

  const filteredOperations = operations.filter(
    (o) =>
      o.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      o.code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const columns = [
    {
      title: '工序编码',
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: '工序名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '工作中心',
      dataIndex: 'work_center_id',
      key: 'work_center_id',
      render: (workCenterId: number) => getWorkCenterName(workCenterId),
    },
    {
      title: '标准工时',
      dataIndex: 'standard_hours',
      key: 'standard_hours',
      render: (hours: number) => `${hours}小时`,
    },
    {
      title: '准备工时',
      dataIndex: 'setup_hours',
      key: 'setup_hours',
      render: (hours: number) => `${hours}小时`,
    },
    {
      title: '人工费率',
      dataIndex: 'labor_rate',
      key: 'labor_rate',
      render: (rate: number) => `¥${(rate ?? 0).toLocaleString()}/小时`,
    },
    {
      title: '制造费率',
      dataIndex: 'overhead_rate',
      key: 'overhead_rate',
      render: (rate: number) => `¥${(rate ?? 0).toLocaleString()}/小时`,
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
      render: (_: any, record: Operation) => (
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
    <Card variant="borderless" title="工序管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增工序</Button>}>

      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索工序名称或编码..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredOperations}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingOperation ? '编辑工序' : '新增工序'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingOperation(null);
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
          <Form.Item
            label="工序编码"
            name="code"
            rules={[{ required: true, message: '请输入工序编码' }]}
          >
            <Input placeholder="请输入工序编码" disabled={!!editingOperation} />
          </Form.Item>
          <Form.Item
            label="工序名称"
            name="name"
            rules={[{ required: true, message: '请输入工序名称' }]}
          >
            <Input placeholder="请输入工序名称" />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <TextArea rows={3} placeholder="请输入描述" />
          </Form.Item>
          <Form.Item label="工作中心" name="work_center_id">
            <Select placeholder="请选择工作中心">
              {workCenters.map((w) => (
                <Option key={w.id} value={w.id}>{w.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="标准工时(小时)" name="standard_hours" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入标准工时" />
          </Form.Item>
          <Form.Item label="准备工时(小时)" name="setup_hours" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入准备工时" />
          </Form.Item>
          <Form.Item label="人工费率" name="labor_rate" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入人工费率" />
          </Form.Item>
          <Form.Item label="制造费率" name="overhead_rate" initialValue={0}>
            <InputNumber style={{ width: '100%' }} placeholder="请输入制造费率" />
          </Form.Item>
          <Form.Item label="状态" name="status" initialValue="active">
            <Select>
              <Option value="active">启用</Option>
              <Option value="inactive">停用</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
