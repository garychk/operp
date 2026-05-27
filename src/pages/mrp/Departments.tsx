import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message } from 'antd';
import { PlusOutlined, SearchOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';

type Department = Tables['erp_departments_s_539dcf81_b']['Row'];

const { Option } = Select;

export function Departments() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchDepartments();
  }, []);

  const fetchDepartments = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_departments_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setDepartments(data || []);
    } catch (error) {
      console.error('Error fetching departments:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingDepartment) {
        await logWithTiming('更新部门', 'UPDATE', async () => {
          const { error } = await supabase
            .from('erp_departments_s_539dcf81_b')
            .update(values)
            .eq('id', editingDepartment.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增部门', 'INSERT', async () => {
          const { error } = await supabase
            .from('erp_departments_s_539dcf81_b')
            .insert([values]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingDepartment(null);
      fetchDepartments();
    } catch (error) {
      console.error('Error saving department:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: Department) => {
    setEditingDepartment(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该部门吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除部门', 'DELETE', async () => {
            const { error } = await supabase
              .from('erp_departments_s_539dcf81_b')
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchDepartments();
        } catch (error) {
          console.error('Error deleting department:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingDepartment(null);
    form.setFieldsValue({
      code: '',
      name: '',
      parent_id: undefined,
      manager_id: undefined,
      company_id: undefined,
      status: 'active',
    });
    setIsModalOpen(true);
  };

  const getParentDepartmentName = (parentId: number | null) => {
    if (!parentId) return '-';
    const parent = departments.find((d) => d.id === parentId);
    return parent?.name || '-';
  };

  const filteredDepartments = departments.filter(
    (d) =>
      d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const columns = [
    {
      title: '部门编码',
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: '部门名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '上级部门',
      dataIndex: 'parent_id',
      key: 'parent_id',
      render: (parentId: number | null) => getParentDepartmentName(parentId),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string | null) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? '启用' : '停用'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: Department) => (
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
    <Card variant="borderless" title="部门管理" extra={
      <Space>
        <Input
          placeholder="搜索部门名称或编码..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增部门</Button>
      </Space>
    }>

      <Table
        columns={columns}
        dataSource={filteredDepartments}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingDepartment ? '编辑部门' : '新增部门'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingDepartment(null);
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
            label="部门编码"
            name="code"
            rules={[{ required: true, message: '请输入部门编码' }]}
          >
            <Input placeholder="请输入部门编码" disabled={!!editingDepartment} />
          </Form.Item>
          <Form.Item
            label="部门名称"
            name="name"
            rules={[{ required: true, message: '请输入部门名称' }]}
          >
            <Input placeholder="请输入部门名称" />
          </Form.Item>
          <Form.Item label="上级部门" name="parent_id">
            <Select placeholder="请选择上级部门" allowClear>
              {departments
                .filter((d) => d.id !== editingDepartment?.id)
                .map((d) => (
                  <Option key={d.id} value={d.id}>{d.name}</Option>
                ))}
            </Select>
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