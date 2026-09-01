import { useState, useEffect, useMemo } from 'react';
import type { Key } from 'react';
import { Table, Button, Modal, Form, Input, Select, InputNumber, Space, Popconfirm, message, Tag, Card, Row, Col } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { menuData } from '../../components/ProLayout';

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
  children?: Menu[];
}

const iconOptions = [
  'DashboardOutlined', 'BookOutlined', 'ShoppingOutlined', 'ToolOutlined',
  'TeamOutlined', 'ShopOutlined', 'InboxOutlined', 'AppstoreOutlined',
  'SettingOutlined', 'BuildOutlined', 'ProfileOutlined', 'CalendarOutlined',
  'ContainerOutlined', 'FileTextOutlined', 'MenuOutlined', 'SafetyOutlined',
];

const excludedStaticMenuPaths = new Set(['/', '/system']);

const getIconName = (icon: any) => icon?.type?.displayName || icon?.type?.name || 'MenuOutlined';

export function Menus() {
  const [menus, setMenus] = useState<Menu[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingMenu, setEditingMenu] = useState<Menu | null>(null);
  const [expandedRowKeys, setExpandedRowKeys] = useState<Key[]>([]);
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
      window.dispatchEvent(new Event('menus-changed'));
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

  const handleMove = async (record: Menu, direction: 'up' | 'down') => {
    const siblings = menus
      .filter(m => m.parent_id === record.parent_id)
      .sort((a, b) => a.sort_order - b.sort_order);

    const idx = siblings.findIndex(m => m.id === record.id);
    if (idx === -1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= siblings.length) return;

    const target = siblings[targetIdx];

    try {
      const { error: err1 } = await supabase
        .from('sys_menus')
        .update({ sort_order: target.sort_order })
        .eq('id', record.id);
      if (err1) throw err1;

      const { error: err2 } = await supabase
        .from('sys_menus')
        .update({ sort_order: record.sort_order })
        .eq('id', target.id);
      if (err2) throw err2;

      fetchMenus();
    } catch {
      message.error('排序失败');
    }
  };

  const handleImportStaticMenus = async () => {
    try {
      const { data: existingMenus, error: existingError } = await supabase
        .from('sys_menus')
        .select('id, path')
        .eq('is_deleted', 'n');

      if (existingError) throw existingError;

      const existingPaths = new Map();
      (existingMenus || []).forEach((item) => {
        if (item.path) existingPaths.set(item.path, item.id);
      });

      let insertedCount = 0;

      const importRoute = async (route: any, parentId: number) => {
        if (excludedStaticMenuPaths.has(route.path)) return;
        const children = route.routes || [];
        const payload = {
          parent_id: parentId,
          menu_name: route.name,
          menu_code: route.path.replace(/^\//, '').replace(/\//g, '_') || 'home',
          menu_type: children.length > 0 ? 'M' : 'C',
          icon: getIconName(route.icon),
          path: route.path,
          component: children.length > 0 ? '' : '.' + route.path,
          sort_order: 0,
          status: '1',
        };

        let currentId = parentId;
        const existingId = existingPaths.get(route.path);
        if (existingId) {
          currentId = existingId;
        } else {
          const { data, error } = await supabase
            .from('sys_menus')
            .insert([payload])
            .select('id')
            .single();
          if (error) throw error;
          currentId = data.id;
          existingPaths.set(route.path, currentId);
          insertedCount += 1;
        }

        for (const child of children) {
          await importRoute(child, currentId);
        }
      };

      for (const route of menuData) {
        await importRoute(route, 0);
      }

      message.success(insertedCount > 0 ? '导入完成，新增 ' + insertedCount + ' 条菜单' : '没有需要导入的菜单');
      fetchMenus();
    } catch (error) {
      message.error('导入静态菜单失败');
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

  const menuTree = useMemo(() => {
    const menuMap = new Map<number, Menu>();
    const roots: Menu[] = [];

    menus.forEach(menu => {
      menuMap.set(menu.id, { ...menu, children: [] });
    });

    menus.forEach(menu => {
      const node = menuMap.get(menu.id);
      if (!node) return;

      const parent = menu.parent_id ? menuMap.get(menu.parent_id) : null;
      if (parent && parent.id !== node.id) {
        parent.children = parent.children || [];
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });

    const removeEmptyChildren = (nodes: Menu[]): Menu[] =>
      nodes.map(node => {
        if (!node.children?.length) {
          const { children, ...leaf } = node;
          return leaf;
        }

        return {
          ...node,
          children: removeEmptyChildren(node.children),
        };
      });

    return removeEmptyChildren(roots);
  }, [menus]);

  const defaultExpandedRowKeys = useMemo(
    () => menus.filter(menu => menus.some(child => child.parent_id === menu.id)).map(menu => menu.id),
    [menus],
  );

  useEffect(() => {
    setExpandedRowKeys(defaultExpandedRowKeys);
  }, [defaultExpandedRowKeys]);

  const columns: ColumnsType<Menu> = [
    {
      title: '菜单名称',
      dataIndex: 'menu_name',
      width: 240,
    },
    {
      title: '菜单编码',
      dataIndex: 'menu_code',
      width: 200,
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
      ellipsis: true,
    },
    {
      title: '排序',
      dataIndex: 'sort_order',
      width: 120,
      render: (sortOrder, record) => (
        <Space size={0}>
          <Button
            type="text"
            size="small"
            icon={<ArrowUpOutlined />}
            onClick={() => handleMove(record, 'up')}
            style={{ color: '#999' }}
          />
          <Button
            type="text"
            size="small"
            icon={<ArrowDownOutlined />}
            onClick={() => handleMove(record, 'down')}
            style={{ color: '#999' }}
          />
          <span style={{ marginLeft: 4 }}>{sortOrder}</span>
        </Space>
      ),
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
      width: 120,
      render: (_, record) => (
        <Space>
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm title="确定删除吗？" onConfirm={() => handleDelete(record.id)}>
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card className='mainContent' variant="borderless" title="菜单管理" extra={<Space><Button onClick={handleImportStaticMenus}>导入静态菜单</Button><Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增菜单</Button></Space>}>
      <Table
        columns={columns}
        dataSource={menuTree}
        loading={loading}
        rowKey="id"
        expandable={{
          expandedRowKeys,
          onExpandedRowsChange: keys => setExpandedRowKeys([...keys]),
        }}
        scroll={{ x: 1200, y: 600 }}
        pagination={false}
      />
      <Modal
        title={editingMenu ? '编辑菜单' : '新增菜单'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Row gutter={16}>
            <Col span={12}>
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
              <Form.Item name="status" label="状态" initialValue="1">
                <Select>
                  <Select.Option value="1">启用</Select.Option>
                  <Select.Option value="0">禁用</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
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
              
            </Col>
          </Row>


        </Form>
      </Modal>
    </Card>
  );
}


