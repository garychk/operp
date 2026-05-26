import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message } from 'antd';
import { PlusOutlined, SearchOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';

type AccountSubject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];

const { Option } = Select;

export function AccountSubjects() {
  const [subjects, setSubjects] = useState<AccountSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSubject, setEditingSubject] = useState<AccountSubject | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchSubjects();
  }, []);

  const fetchSubjects = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_account_subjects_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('code');

      if (error) throw error;
      setSubjects(data || []);
    } catch (error) {
      console.error('Error fetching subjects:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingSubject) {
        const { error } = await supabase
          .from('erp_account_subjects_s_539dcf81_b')
          .update(values)
          .eq('id', editingSubject.id);
        if (error) throw error;
        message.success('更新成功');
      } else {
        const { error } = await supabase
          .from('erp_account_subjects_s_539dcf81_b')
          .insert([values]);
        if (error) throw error;
        message.success('新增成功');
      }
      setIsModalOpen(false);
      setEditingSubject(null);
      form.resetFields();
      fetchSubjects();
    } catch (error) {
      console.error('Error saving subject:', error);
      message.error('保存失败');
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该科目吗？',
      onOk: async () => {
        try {
          const { error } = await supabase
            .from('erp_account_subjects_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success('删除成功');
          fetchSubjects();
        } catch (error) {
          console.error('Error deleting subject:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleEdit = (subject: AccountSubject) => {
    setEditingSubject(subject);
    form.setFieldsValue({
      code: subject.code,
      name: subject.name,
      category: subject.category,
      direction: subject.direction || 'debit',
      parent_id: subject.parent_id,
    });
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingSubject(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const filteredSubjects = subjects.filter(
    (s) =>
      s.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const categoryLabels: Record<string, string> = {
    asset: '资产类',
    liability: '负债类',
    equity: '权益类',
    revenue: '收入类',
    expense: '费用类',
  };

  const columns = [
    {
      title: '科目代码',
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: '科目名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '类别',
      dataIndex: 'category',
      key: 'category',
      render: (category: string) => categoryLabels[category] || category,
    },
    {
      title: '余额方向',
      dataIndex: 'direction',
      key: 'direction',
      render: (direction: string) => (direction === 'debit' ? '借方' : '贷方'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? '启用' : '禁用'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: AccountSubject) => (
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
    <Card variant="borderless" title="会计科目管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增科目</Button>}>

      <div style={{ marginBottom: 16 }}>
        <Input
          placeholder="搜索科目代码或名称..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
      </div>

      <Table
        columns={columns}
        dataSource={filteredSubjects}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingSubject ? '编辑科目' : '新增科目'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingSubject(null);
          form.resetFields();
        }}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label="科目代码"
            name="code"
            rules={[{ required: true, message: '请输入科目代码' }]}
          >
            <Input placeholder="请输入科目代码" />
          </Form.Item>
          <Form.Item
            label="科目名称"
            name="name"
            rules={[{ required: true, message: '请输入科目名称' }]}
          >
            <Input placeholder="请输入科目名称" />
          </Form.Item>
          <Form.Item
            label="科目类别"
            name="category"
            rules={[{ required: true, message: '请选择科目类别' }]}
          >
            <Select placeholder="请选择">
              <Option value="asset">资产类</Option>
              <Option value="liability">负债类</Option>
              <Option value="equity">权益类</Option>
              <Option value="revenue">收入类</Option>
              <Option value="expense">费用类</Option>
            </Select>
          </Form.Item>
          <Form.Item label="余额方向" name="direction">
            <Select>
              <Option value="debit">借方</Option>
              <Option value="credit">贷方</Option>
            </Select>
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
