import { useState, useEffect } from 'react';
import { Table, Button, Modal, Form, Input, Select, InputNumber, Space, Popconfirm, message, Tag, Card } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';

interface Menu {
  id: number;
  parent_id: number;
  menu_name: string;
  menu_code: string;
  menu_type: string;
  icon: string;
  path: string;
  component: string;
  sort_order: number;
  status: string;
  created_at: string;
}

const iconOptions = [
  'DashboardOutlined', 'BookOutlined', 'ShoppingOutlined', 'ToolOutlined',
  'TeamOutlined', 'ShopOutlined', 'InboxOutlined', 'AppstoreOutlined',
  'SettingOutlined', 'BuildOutlined', 'ProfileOutlined', 'CalendarOutlined',
  'ContainerOutlined', 'FileTextOutlined', 'MenuOutlined', 'SafetyOutlined',
];

export function Menus() {
  const [menus, setMenus] = useState<Menu[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingMenu, setEditingMenu] = useState<Menu | null>(null);
  const [form] = Form.useForm();

  const fetchMenus = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('sys_menus')
        .select('*')
        .eq('is_deleted', 'n')
        .order('sort_order', { ascending: true });
      
      if (error) throw error;
      setMenus(data || []);
    } catch (error) {
      message.error('获取菜单列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMenus();
  }, []);

  const handleAdd = () => {
    setEditingMenu(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record: Menu) => {
    setEditingMenu(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await logWithTiming('删除菜单', 'DELETE', async () => {
        const { error } = await supabase
          .from('sys_menus')
          .update({ is_deleted: 'y' })
          .eq('id', id);
        if (error) throw error;
      });
      message.success('删除成功');
      fetchMenus();
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handleSave = async (values: any) => {
    try {
      if (editingMenu) {
        await logWithTiming('更新菜单', 'UPDATE', async () => {
          const { error } = await supabase
            .from('sys_menus')
            .update(values)
            .eq('id', editingMenu.id);
          if (error) throw error;
        });
        message.success('更新成功');
      } else {
        await logWithTiming('创建菜单', 'INSERT', async () => {
          const { error } = await supabase
            .from('sys_menus')
            .insert([values]);
          if (error) throw error;
        });
        message.success('创建成功');
      }
      setModalVisible(false);
      fetchMenus();
    } catch (error) {
      message.error('保存失败');
    }
  };

  const getParentName = (parentId: number) => {
    if (parentId === 0) return '根菜单';
    const parent = menus.find(m => m.id === parentId);
    return parent ? parent.menu_name : '未知';
  };

  const columns: ColumnsType<Menu> = [
    {
      title: '菜单名称',
      dataIndex: 'menu_name',
      width: 150,
    },
    {
      title: '菜单编码',
      dataIndex: 'menu_code',
      width: 120,
    },
    {
      title: '类型',
      dataIndex: 'menu_type',
      width: 80,
      render: (type) => (
        <Tag color={type === 'M' ? 'blue' : 'green'}>
          {type === 'M' ? '目录' : '菜单'}
        </Tag>
      ),
    },
    {
      title: '上级菜单',
      dataIndex: 'parent_id',
      width: 120,
      render: (id) => getParentName(id),
    },
    {
      title: '路径',
      dataIndex: 'path',
      ellipsis: true,
    },
    {
      title: '组件',
      dataIndex: 'component',
      ellipsis: true,
    },
    {
      title: '图标',
      dataIndex: 'icon',
      width: 120,
    },
    {
      title: '排序',
      dataIndex: 'sort_order',
      width: 80,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (status) => (
        <Tag color={status === '1' ? 'success' : 'error'}>
          {status === '1' ? '启用' : '禁用'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 200,
      render: (_, record) => (
        <Space>
          <Button type="primary" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Popconfirm title="确定删除吗？" onConfirm={() => handleDelete(record.id)}>
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title="菜单管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增菜单</Button>}>      
      
      <Table
        columns={columns}
        dataSource={menus}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1200 }}
      />
      <Modal
        title={editingMenu ? '编辑菜单' : '新增菜单'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="parent_id" label="上级菜单" initialValue={0}>
            <Select>
              <Select.Option value={0}>根菜单</Select.Option>
              {menus.filter(m => m.menu_type === 'M').map(m => (
                <Select.Option key={m.id} value={m.id}>{m.menu_name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="menu_name" label="菜单名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="menu_code" label="菜单编码" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="menu_type" label="菜单类型" initialValue="M">
            <Select>
              <Select.Option value="M">目录</Select.Option>
              <Select.Option value="C">菜单</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="icon" label="图标">
            <Select placeholder="请选择图标">
              {iconOptions.map(icon => (
                <Select.Option key={icon} value={icon}>{icon}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="path" label="路由路径">
            <Input placeholder="如: /system/users" />
          </Form.Item>
          <Form.Item name="component" label="组件路径">
            <Input placeholder="如: ./pages/system/Users" />
          </Form.Item>
          <Form.Item name="sort_order" label="排序" initialValue={0}>
            <InputNumber min={0} />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="1">
            <Select>
              <Select.Option value="1">启用</Select.Option>
              <Select.Option value="0">禁用</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
