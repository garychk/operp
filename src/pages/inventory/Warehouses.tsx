import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Tag, Modal, Form, Select, Space, message, Checkbox } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '@/utils/supabase';
import { logWithTiming } from '@/utils/logger';
import type { Tables } from '@/utils/supabase';
import { SuperTable } from '@/components/SuperTable';
import SimpleModal from '@/components/SimpleModal';

type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];
type Employee = Tables['erp_employees_s_539dcf81_b']['Row'];

const { Option } = Select;
const warehouseTable = 'erp_warehouses_s_539dcf81_b';

export function Warehouses() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchWarehouses();
    fetchEmployees();
  }, []);

  const fetchWarehouses = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(warehouseTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error('Error fetching warehouses:', error);
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchEmployees = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_employees_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setEmployees(data || []);
    } catch (error) {
      console.error('Error fetching employees:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingWarehouse) {
        await logWithTiming('更新仓库', 'UPDATE', async () => {
          const { error } = await supabase
            .from(warehouseTable)
            .update(values)
            .eq('id', editingWarehouse.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('新增仓库', 'INSERT', async () => {
          const { error } = await supabase
            .from(warehouseTable)
            .insert([values]);
          if (error) throw error;
        });
        message.success('新增成功');
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingWarehouse(null);
      fetchWarehouses();
    } catch (error) {
      console.error('Error saving warehouse:', error);
      message.error('保存失败');
    }
  };

  const handleEdit = (record: Warehouse) => {
    setEditingWarehouse(record);
    form.setFieldsValue({
      ...record,
      is_negative_stock_allowed: record.is_negative_stock_allowed ?? false,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该仓库吗？',
      onOk: async () => {
        try {
          await logWithTiming('删除仓库', 'DELETE', async () => {
            const { error } = await supabase
              .from(warehouseTable)
            .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success('删除成功');
          fetchWarehouses();
        } catch (error) {
          console.error('Error deleting warehouse:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingWarehouse(null);
    form.setFieldsValue({
      code: '',
      name: '',
      type: 'raw_material',
      location: '',
      manager_id: undefined,
      is_negative_stock_allowed: false,
      status: 'active',
    });
    setIsModalOpen(true);
  };

  const getManagerName = (managerId: number | null) => {
    const employee = employees.find((e) => e.id === managerId);
    return employee?.name || '-';
  };

  const filteredWarehouses = warehouses.filter(
    (w) =>
      w.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      w.code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const typeLabels: Record<string, string> = {
    raw_material: '原材料仓',
    finished: '成品仓',
    semi_finished: '半成品仓',
    return: '退货仓',
    scrap: '废料仓',
    other: '其他',
  };

  const columns = [
    {
      title: '仓库编码',
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: '仓库名称',
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
      title: '位置',
      dataIndex: 'location',
      key: 'location',
      render: (text: string) => text || '-',
    },
    {
      title: '负责人',
      dataIndex: 'manager_id',
      key: 'manager_id',
      render: (managerId: number) => getManagerName(managerId),
    },
    {
      title: '允许负库存',
      dataIndex: 'is_negative_stock_allowed',
      key: 'is_negative_stock_allowed',
      render: (allowed: boolean) => (allowed ? '是' : '否'),
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
      render: (_: any, record: Warehouse) => (
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
    <div className="mainContent">
      <SuperTable
        columns={columns}
        dataSource={filteredWarehouses}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="warehouses"
        headerTitle="仓库管理"
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增仓库</Button>
            <Input.Search
              allowClear
              placeholder="搜索仓库名称或编码..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchWarehouses}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal  
        title={editingWarehouse ? '编辑仓库' : '新增仓库'}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingWarehouse(null);
        }}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label="仓库编码"
            name="code"
            rules={[{ required: true, message: '请输入仓库编码' }]}
          >
            <Input placeholder="请输入仓库编码" disabled={!!editingWarehouse} />
          </Form.Item>
          <Form.Item
            label="仓库名称"
            name="name"
            rules={[{ required: true, message: '请输入仓库名称' }]}
          >
            <Input placeholder="请输入仓库名称" />
          </Form.Item>
          <Form.Item label="类型" name="type" initialValue="raw_material">
            <Select>
              <Option value="raw_material">原材料仓</Option>
              <Option value="finished">成品仓</Option>
              <Option value="semi_finished">半成品仓</Option>
              <Option value="return">退货仓</Option>
              <Option value="scrap">废料仓</Option>
              <Option value="other">其他</Option>
            </Select>
          </Form.Item>
          <Form.Item label="位置" name="location">
            <Input placeholder="请输入位置" />
          </Form.Item>
          <Form.Item label="负责人" name="manager_id">
            <Select placeholder="请选择负责人">
              {employees.map((e) => (
                <Option key={e.id} value={e.id}>{e.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="允许负库存" name="is_negative_stock_allowed" valuePropName="checked" initialValue={false}>
            <Checkbox />
          </Form.Item>
          <Form.Item label="状态" name="status" initialValue="active">
            <Select>
              <Option value="active">启用</Option>
              <Option value="inactive">停用</Option>
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
      </SimpleModal>
    </div>
  );
}
