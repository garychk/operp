import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Key } from 'react';
import { Table, Button, Form, Input, Select, InputNumber, Space, Popconfirm, message, Tag, Card, Row, Col } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { menuData, staticComponentByPath } from '../../components/ProLayout';
import SimpleModal from '../../components/SimpleModal';

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
  'DashboardOutlined', 'BookOutlined', 'ShoppingOutlined', 'ShoppingCartOutlined', 'ToolOutlined',
  'TeamOutlined', 'ShopOutlined', 'InboxOutlined', 'ImportOutlined', 'AppstoreOutlined',
  'SettingOutlined', 'BuildOutlined', 'BranchesOutlined', 'ProfileOutlined', 'CalendarOutlined',
  'ContainerOutlined', 'FileTextOutlined', 'MenuOutlined', 'SafetyOutlined',
  'TruckOutlined', 'RiseOutlined', 'FallOutlined', 'TableOutlined', 'UnorderedListOutlined',
  'SwapOutlined', 'ExperimentOutlined', 'LineChartOutlined', 'BarChartOutlined',
  'CheckCircleOutlined', 'CalculatorOutlined',
];

const excludedStaticMenuPaths = new Set(['/']);

const getIconName = (icon: any) => icon?.type?.displayName || icon?.type?.name || 'MenuOutlined';

export function Menus() {
  const { t } = useTranslation();
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
      message.error(t('menus.fetchFailed'));
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
      await logWithTiming(t('menus.logDelete'), 'DELETE', async () => {
        const { error } = await supabase
          .from('sys_menus')
          .update({ is_deleted: 'y' })
          .eq('id', id);
        if (error) throw error;
      });
      message.success(t('common.deleteSuccess'));
      fetchMenus();
    } catch (error) {
      message.error(t('common.deleteFailed'));
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
      message.error(t('menus.sortFailed'));
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

      const importRoute = async (route: any, parentId: number, index = 0) => {
        const children = route.routes || [];
        const existingId = existingPaths.get(route.path);
        let currentId = existingId ?? parentId;

        if (!existingId && !excludedStaticMenuPaths.has(route.path)) {
          const payload = {
            parent_id: parentId,
            menu_name: route.name,
            menu_code: route.path.replace(/^\//, '').replace(/\//g, '_') || 'home',
            menu_type: children.length > 0 ? 'M' : 'C',
            icon: getIconName(route.icon),
            path: route.path,
            component: staticComponentByPath[route.path] || '',
            sort_order: index + 1,
            status: '1',
          };

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

        for (const [childIndex, child] of children.entries()) {
          await importRoute(child, currentId, childIndex);
        }
      };

      for (const [index, route] of menuData.entries()) {
        await importRoute(route, 0, index);
      }

      message.success(insertedCount > 0 ? t('menus.importCompleted', { count: insertedCount }) : t('menus.importEmpty'));
      fetchMenus();
    } catch (error) {
      message.error(t('menus.importStaticFailed'));
    }
  };

  const handleSave = async (values: any) => {
    try {
      if (editingMenu) {
        await logWithTiming(t('menus.logUpdate'), 'UPDATE', async () => {
          const { error } = await supabase
            .from('sys_menus')
            .update(values)
            .eq('id', editingMenu.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming(t('menus.logCreate'), 'INSERT', async () => {
          const { error } = await supabase
            .from('sys_menus')
            .insert([values]);
          if (error) throw error;
        });
        message.success(t('menus.createSuccess'));
      }
      setModalVisible(false);
      fetchMenus();
    } catch (error) {
      message.error(t('common.saveFailed'));
    }
  };

  const getParentName = (parentId: number) => {
    if (parentId === 0) return t('menus.rootMenu');
    const parent = menus.find(m => m.id === parentId);
    return parent ? parent.menu_name : t('menus.unknown');
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
      title: t('menus.menuName'),
      dataIndex: 'menu_name',
      width: 240,
    },
    {
      title: t('menus.menuCode'),
      dataIndex: 'menu_code',
      width: 200,
    },
    {
      title: t('common.type'),
      dataIndex: 'menu_type',
      width: 80,
      render: (type) => (
        <Tag color={type === 'M' ? 'blue' : 'green'}>
          {type === 'M' ? t('menus.directory') : t('menus.menu')}
        </Tag>
      ),
    },
    {
      title: t('menus.parentMenu'),
      dataIndex: 'parent_id',
      width: 120,
      render: (id) => getParentName(id),
    },
    {
      title: t('menus.path'),
      dataIndex: 'path',
      ellipsis: true,
    },
    {
      title: t('menus.component'),
      dataIndex: 'component',
      ellipsis: true,
    },
    {
      title: t('menus.icon'),
      dataIndex: 'icon',
      width: 120,
      ellipsis: true,
    },
    {
      title: t('menus.sortOrder'),
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
      title: t('common.status'),
      dataIndex: 'status',
      width: 80,
      render: (status) => (
        <Tag color={status === '1' ? 'success' : 'error'}>
          {status === '1' ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('common.actions'),
      key: 'action',
      fixed: 'right',
      width: 120,
      render: (_, record) => (
        <Space>
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm title={t('menus.deleteConfirm')} onConfirm={() => handleDelete(record.id)}>
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title={t('menus.title')} extra={<Space><Button onClick={handleImportStaticMenus}>{t('menus.importStaticMenus')}</Button><Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('menus.addMenu')}</Button></Space>}>
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
      <SimpleModal
        title={editingMenu ? t('menus.editMenu') : t('menus.addMenu')}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="parent_id" label={t('menus.parentMenu')} initialValue={0}>
                <Select>
                  <Select.Option value={0}>{t('menus.rootMenu')}</Select.Option>
                  {menus.filter(m => m.menu_type === 'M').map(m => (
                    <Select.Option key={m.id} value={m.id}>{m.menu_name}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item name="menu_name" label={t('menus.menuName')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="menu_code" label={t('menus.menuCode')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
              <Form.Item name="menu_type" label={t('menus.menuType')} initialValue="M">
                <Select>
                  <Select.Option value="M">{t('menus.directory')}</Select.Option>
                  <Select.Option value="C">{t('menus.menu')}</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item name="status" label={t('common.status')} initialValue="1">
                <Select>
                  <Select.Option value="1">{t('common.enabled')}</Select.Option>
                  <Select.Option value="0">{t('common.disabled')}</Select.Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="icon" label={t('menus.icon')}>
                <Select placeholder={t('menus.iconPlaceholder')}>
                  {iconOptions.map(icon => (
                    <Select.Option key={icon} value={icon}>{icon}</Select.Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item name="path" label={t('menus.routePath')}>
                <Input placeholder={t('menus.pathPlaceholder')} />
              </Form.Item>
              <Form.Item name="component" label={t('menus.componentPath')}>
                <Input placeholder={t('menus.componentPlaceholder')} />
              </Form.Item>
              <Form.Item name="sort_order" label={t('menus.sortOrder')} initialValue={0}>
                <InputNumber min={0} />
              </Form.Item>
              
            </Col>
          </Row>


        </Form>
      </SimpleModal>
    </Card>
  );
}


