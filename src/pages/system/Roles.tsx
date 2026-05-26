import { useState, useEffect } from 'react';
import { Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message, Tag, TreeSelect, Card } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SafetyOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';

interface Role {
  id: number;
  role_code: string;
  role_name: string;
  description: string;
  sort_order: number;
  status: string;
  created_at: string;
}

interface Menu {
  id: number;
  menu_name: string;
  parent_id: number;
}

export function Roles() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [permissionModalVisible, setPermissionModalVisible] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [currentRoleId, setCurrentRoleId] = useState<number | null>(null);
  const [selectedMenus, setSelectedMenus] = useState<number[]>([]);
  const [form] = Form.useForm();

  const fetchRoles = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('sys_roles')
        .select('*')
        .eq('is_deleted', 'n')
        .order('sort_order', { ascending: true });
      
      if (error) throw error;
      setRoles(data || []);
    } catch (error) {
      message.error('获取角色列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchMenus = async () => {
    try {
      const { data, error } = await supabase
        .from('sys_menus')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', '1');
      
      if (error) throw error;
      setMenus(data || []);
    } catch (error) {
      message.error('获取菜单列表失败');
    }
  };

  const fetchRoleMenus = async (roleId: number) => {
    try {
      const { data, error } = await supabase
        .from('sys_role_menus')
        .select('menu_id')
        .eq('role_id', roleId);
      
      if (error) throw error;
      setSelectedMenus(data?.map((item: any) => item.menu_id) || []);
    } catch (error) {
      message.error('获取角色权限失败');
    }
  };

  useEffect(() => {
    fetchRoles();
    fetchMenus();
  }, []);

  const handleAdd = () => {
    setEditingRole(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record: Role) => {
    setEditingRole(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await logWithTiming('删除角色', 'DELETE', async () => {
        const { error } = await supabase
          .from('sys_roles')
          .update({ is_deleted: 'y' })
          .eq('id', id);
        if (error) throw error;
      });
      message.success('删除成功');
      fetchRoles();
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handlePermission = async (record: Role) => {
    setCurrentRoleId(record.id);
    await fetchRoleMenus(record.id);
    setPermissionModalVisible(true);
  };

  const handleSavePermission = async () => {
    try {
      await supabase
        .from('sys_role_menus')
        .delete()
        .eq('role_id', currentRoleId);
      
      const inserts = selectedMenus.map(menuId => ({
        role_id: currentRoleId,
        menu_id: menuId,
      }));
      
      if (inserts.length > 0) {
        const { error } = await supabase
          .from('sys_role_menus')
          .insert(inserts);
        if (error) throw error;
      }
      
      message.success('权限设置成功');
      setPermissionModalVisible(false);
    } catch (error) {
      message.error('权限设置失败');
    }
  };

  const handleSave = async (values: any) => {
    try {
      if (editingRole) {
        const { error } = await supabase
          .from('sys_roles')
          .update(values)
          .eq('id', editingRole.id);
        if (error) throw error;
        message.success('更新成功');
      } else {
        const { error } = await supabase
          .from('sys_roles')
          .insert([values]);
        if (error) throw error;
        message.success('创建成功');
      }
      setModalVisible(false);
      fetchRoles();
    } catch (error) {
      message.error('保存失败');
    }
  };

  const buildMenuTree = (menus: Menu[]): any[] => {
    const menuMap = new Map<number, any>();
    menus.forEach(menu => {
      menuMap.set(menu.id, { ...menu, key: menu.id, value: menu.id, title: menu.menu_name, children: [] });
    });
    const tree: any[] = [];
    menus.forEach(menu => {
      if (menu.parent_id === 0) {
        tree.push(menuMap.get(menu.id));
      } else {
        const parent = menuMap.get(menu.parent_id);
        if (parent) {
          parent.children.push(menuMap.get(menu.id));
        }
      }
    });
    return tree;
  };

  const columns: ColumnsType<Role> = [
    {
      title: '角色编码',
      dataIndex: 'role_code',
      width: 200,
    },
    {
      title: '角色名称',
      dataIndex: 'role_name',
      width: 150,
    },
    {
      title: '描述',
      dataIndex: 'description',
      ellipsis: true,      
    },
    {
      title: '排序',
      dataIndex: 'sort_order',
      width: 80,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === '1' ? 'success' : 'error'}>
          {status === '1' ? '启用' : '禁用'}
        </Tag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 180,
      render: (date) => new Date(date).toLocaleString(),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button type="primary" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button icon={<SafetyOutlined />} onClick={() => handlePermission(record)}>
            权限
          </Button>
          <Popconfirm title="确定删除吗？" onConfirm={() => handleDelete(record.id)}>
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title="角色管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增角色</Button>}>      
      
      <Table
        columns={columns}
        dataSource={roles}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1000 }}
      />
      <Modal
        title={editingRole ? '编辑角色' : '新增角色'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="role_code" label="角色编码" rules={[{ required: true }]}>
            <Input disabled={!!editingRole} />
          </Form.Item>
          <Form.Item name="role_name" label="角色名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="sort_order" label="排序" initialValue={0}>
            <Input type="number" />
          </Form.Item>
          <Form.Item name="status" label="状态" initialValue="1">
            <Select>
              <Select.Option value="1">启用</Select.Option>
              <Select.Option value="0">禁用</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="设置权限"
        open={permissionModalVisible}
        onCancel={() => setPermissionModalVisible(false)}
        onOk={handleSavePermission}
        width={500}
      >
        <TreeSelect
          treeData={buildMenuTree(menus)}
          value={selectedMenus}
          onChange={setSelectedMenus}
          treeCheckable
          treeDefaultExpandAll
          style={{ width: '100%' }}
          placeholder="请选择菜单权限"
        />
      </Modal>
    </Card>
  );
}
