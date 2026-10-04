import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Table,
  Button,
  Modal,
  Form,
  Input,
  Select,
  Space,
  Popconfirm,
  message,
  Tag,
  Tree,
  Card,
  Tabs,
  Checkbox,
  Empty,
  Switch,
  InputNumber,
} from "antd";
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import SimpleModal from "../../components/SimpleModal";

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
  menu_code: string;
  parent_id: number;
}

interface SysTable {
  id: number;
  table_name: string;
  table_label: string;
  module_name: string;
}

interface TablePermission {
  table_id: number;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
}

type PermissionAction =
  | "can_select"
  | "can_insert"
  | "can_update"
  | "can_delete";

export function Roles() {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<Role[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [sysTables, setSysTables] = useState<SysTable[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [permissionModalVisible, setPermissionModalVisible] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [currentRoleId, setCurrentRoleId] = useState<number | null>(null);
  const [selectedMenus, setSelectedMenus] = useState<number[]>([]);
  const [tablePermissions, setTablePermissions] = useState<TablePermission[]>(
    [],
  );
  const [tablePermissionSearch, setTablePermissionSearch] = useState("");
  const [form] = Form.useForm();

  const fetchRoles = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("sys_roles")
        .select("*")
        .eq("is_deleted", "n")
        .order("sort_order", { ascending: true });

      if (error) throw error;
      setRoles(data || []);
    } catch (error) {
      message.error(t('roles.fetchRolesFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchMenus = async () => {
    try {
      const { data, error } = await supabase
        .from("sys_menus")
        .select("*")
        .eq("is_deleted", "n")
        .eq("status", "1")
        .order("sort_order", { ascending: true });

      if (error) throw error;
      setMenus(data || []);
    } catch (error) {
      message.error(t('roles.fetchMenusFailed'));
    }
  };

  const fetchRoleMenus = async (roleId: number) => {
    try {
      const { data, error } = await supabase
        .from("sys_role_menus")
        .select("menu_id")
        .eq("role_id", roleId);

      if (error) throw error;
      setSelectedMenus(data?.map((item: any) => item.menu_id) || []);
    } catch (error) {
      message.error(t('roles.fetchRolePermissionsFailed'));
    }
  };

  const fetchSysTables = async () => {
    try {
      const { data, error } = await supabase
        .from("sys_tables")
        .select("id, table_name, table_label, module_name")
        .eq("is_deleted", "n")
        .eq("status", "1")
        .order("module_name", { ascending: true })
        .order("table_name", { ascending: true });

      if (error) throw error;
      setSysTables(data || []);
    } catch (error) {
      message.error(t('roles.fetchTablesFailed'));
    }
  };

  const fetchRoleTablePermissions = async (roleId: number) => {
    try {
      const { data, error } = await supabase
        .from("sys_role_table_permissions")
        .select("table_id, can_select, can_insert, can_update, can_delete")
        .eq("role_id", roleId)
        .eq("is_deleted", "n");

      if (error) throw error;
      setTablePermissions((data || []) as TablePermission[]);
    } catch (error) {
      message.error(t('roles.fetchTablePermissionsFailed'));
    }
  };

  useEffect(() => {
    fetchRoles();
    fetchMenus();
    fetchSysTables();
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
      await logWithTiming(t('roles.logDelete'), "DELETE", async () => {
        const { error } = await supabase
          .from("sys_roles")
          .update({ is_deleted: "y" })
          .eq("id", id);
        if (error) throw error;
      });
      message.success(t('common.deleteSuccess'));
      fetchRoles();
    } catch (error) {
      message.error(t('common.deleteFailed'));
    }
  };

  const handlePermission = async (record: Role) => {
    setCurrentRoleId(record.id);
    setTablePermissionSearch("");
    await Promise.all([
      fetchRoleMenus(record.id),
      fetchRoleTablePermissions(record.id),
    ]);
    setPermissionModalVisible(true);
  };

  const handleSavePermission = async () => {
    try {
      await supabase
        .from("sys_role_menus")
        .delete()
        .eq("role_id", currentRoleId);

      const inserts = selectedMenus.map((menuId) => ({
        role_id: currentRoleId,
        menu_id: menuId,
      }));

      if (inserts.length > 0) {
        const { error } = await supabase.from("sys_role_menus").insert(inserts);
        if (error) throw error;
      }

      const { error: deleteTablePermissionError } = await supabase
        .from("sys_role_table_permissions")
        .delete()
        .eq("role_id", currentRoleId);

      if (deleteTablePermissionError) throw deleteTablePermissionError;

      const tablePermissionInserts = tablePermissions
        .filter(
          (permission) =>
            permission.can_select ||
            permission.can_insert ||
            permission.can_update ||
            permission.can_delete,
        )
        .map((permission) => ({
          role_id: currentRoleId,
          ...permission,
        }));

      if (tablePermissionInserts.length > 0) {
        const { error } = await supabase
          .from("sys_role_table_permissions")
          .insert(tablePermissionInserts);

        if (error) throw error;
      }

      message.success(t('roles.permissionSaveSuccess'));
      setPermissionModalVisible(false);
    } catch (error) {
      message.error(t('roles.permissionSaveFailed'));
    }
  };

  const handleSave = async (values: any) => {
    try {
      if (editingRole) {
        const { error } = await supabase
          .from("sys_roles")
          .update(values)
          .eq("id", editingRole.id);
        if (error) throw error;
        message.success(t('common.updateSuccess'));
      } else {
        const { error } = await supabase.from("sys_roles").insert([values]);
        if (error) throw error;
        message.success(t('roles.createSuccess'));
      }
      setModalVisible(false);
      fetchRoles();
    } catch (error) {
      message.error(t('common.saveFailed'));
    }
  };

  const buildMenuTree = (menus: Menu[]): any[] => {
    const menuMap = new Map<number, any>();
    menus.forEach((menu) => {
      menuMap.set(menu.id, {
        ...menu,
        key: menu.id,
        value: menu.id,
        title: menu.menu_name + " - " + menu.menu_code,
        children: [],
      });
    });
    const tree: any[] = [];
    menus.forEach((menu) => {
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

  const getTablePermission = (tableId: number) =>
    tablePermissions.find((permission) => permission.table_id === tableId) || {
      table_id: tableId,
      can_select: false,
      can_insert: false,
      can_update: false,
      can_delete: false,
    };

  const updateTablePermission = (
    tableId: number,
    action: PermissionAction,
    checked: boolean,
  ) => {
    setTablePermissions((prev) => {
      const current = prev.find(
        (permission) => permission.table_id === tableId,
      );
      if (current) {
        return prev.map((permission) =>
          permission.table_id === tableId
            ? { ...permission, [action]: checked }
            : permission,
        );
      }

      return [
        ...prev,
        {
          table_id: tableId,
          can_select: false,
          can_insert: false,
          can_update: false,
          can_delete: false,
          [action]: checked,
        },
      ];
    });
  };

  const filteredSysTables = sysTables.filter((table) => {
    const keyword = tablePermissionSearch.trim().toLowerCase();
    if (!keyword) return true;

    return (
      table.table_name.toLowerCase().includes(keyword) ||
      table.table_label.toLowerCase().includes(keyword)
    );
  });

  const updateVisibleTablePermissions = (
    action: PermissionAction,
    checked: boolean,
  ) => {
    filteredSysTables.forEach((table) => {
      updateTablePermission(table.id, action, checked);
    });
  };

  const isVisibleTablePermissionChecked = (action: PermissionAction) =>
    filteredSysTables.length > 0 &&
    filteredSysTables.every((table) => getTablePermission(table.id)[action]);

  const tablePermissionColumns: ColumnsType<SysTable> = [
    {
      title: t('roles.module'),
      dataIndex: "module_name",
      width: 120,
      render: (moduleName) => <Tag>{moduleName}</Tag>,
    },
    {
      title: t('roles.dataTable'),
      dataIndex: "table_label",
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span>{record.table_label}</span>
          <span style={{ color: "#999", fontSize: 12 }}>
            {record.table_name}
          </span>
        </Space>
      ),
    },
    {
      title: t('roles.query'),
      width: 70,
      align: "center",
      render: (_, record) => (
        <Checkbox
          checked={getTablePermission(record.id).can_select}
          onChange={(event) =>
            updateTablePermission(record.id, "can_select", event.target.checked)
          }
        />
      ),
    },
    {
      title: t('roles.insert'),
      width: 70,
      align: "center",
      render: (_, record) => (
        <Checkbox
          checked={getTablePermission(record.id).can_insert}
          onChange={(event) =>
            updateTablePermission(record.id, "can_insert", event.target.checked)
          }
        />
      ),
    },
    {
      title: t('roles.update'),
      width: 70,
      align: "center",
      render: (_, record) => (
        <Checkbox
          checked={getTablePermission(record.id).can_update}
          onChange={(event) =>
            updateTablePermission(record.id, "can_update", event.target.checked)
          }
        />
      ),
    },
    {
      title: t('common.delete'),
      width: 70,
      align: "center",
      render: (_, record) => (
        <Checkbox
          checked={getTablePermission(record.id).can_delete}
          onChange={(event) =>
            updateTablePermission(record.id, "can_delete", event.target.checked)
          }
        />
      ),
    },
  ];

  const columns: ColumnsType<Role> = [
    {
      title: t('roles.roleCode'),
      dataIndex: "role_code",
      width: 200,
    },
    {
      title: t('roles.roleName'),
      dataIndex: "role_name",
      width: 150,
    },
    {
      title: t('roles.description'),
      dataIndex: "description",
      ellipsis: true,
    },
    {
      title: t('roles.sort'),
      dataIndex: "sort_order",
      width: 120,
    },
    {
      title: t('common.status'),
      dataIndex: "status",
      width: 100,
      render: (status) => (
        <Tag color={status === "1" ? "success" : "error"}>
          {status === "1" ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('roles.createdAt'),
      dataIndex: "created_at",
      width: 180,
      render: (date) => new Date(date).toLocaleString(),
    },
    {
      title: t('common.actions'),
      key: "action",
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            
          </Button>
          <Button
            type="text"
            icon={<SafetyOutlined />}
            onClick={() => handlePermission(record)}
          >
            {t('roles.permission')}
          </Button>
          <Popconfirm
            title={t('roles.deleteConfirm')}
            onConfirm={() => handleDelete(record.id)}
          >
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}>
              
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      variant="borderless"
      title={t('roles.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          {t('roles.addRole')}
        </Button>
      }
    >
      <Table
        columns={columns}
        dataSource={roles}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1000 }}
      />
      <SimpleModal
        title={editingRole ? t('roles.editRole') : t('roles.addRole')}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={400}
      >
        <Card size="small">
          <Form
            form={form}
            layout="vertical"
            onFinish={handleSave}            
          >
            <Form.Item
              name="role_code"
              label={t('roles.roleCode')}
              rules={[{ required: true }]}
            >
              <Input disabled={!!editingRole} />
            </Form.Item>
            <Form.Item
              name="role_name"
              label={t('roles.roleName')}
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="description" label={t('roles.description')}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="sort_order" label={t('roles.sort')} initialValue={0}>
              <InputNumber />
            </Form.Item>
            <Form.Item name="status" label={t('common.status')} initialValue="1">
              <Select>
                <Select.Option value="1">{t('common.enabled')}</Select.Option>
                <Select.Option value="0">{t('common.disabled')}</Select.Option>
              </Select>
            </Form.Item>
          </Form>
        </Card>
      </SimpleModal>
      <Modal
        title={t('roles.setPermission')}
        open={permissionModalVisible}
        onCancel={() => setPermissionModalVisible(false)}
        onOk={handleSavePermission}
        width={820}
      >
        <Tabs
          items={[
            {
              key: "menus",
              label: t('roles.menuPermission'),
              children: (
                <Tree
                  treeData={buildMenuTree(menus)}
                  checkedKeys={selectedMenus}
                  onCheck={(checkedKeys) => {
                    if (Array.isArray(checkedKeys)) {
                      setSelectedMenus(checkedKeys as number[]);
                    }
                  }}
                  checkable
                  defaultExpandAll
                  style={{ width: "100%" }}
                  height={480}
                />
              ),
            },
            {
              key: "tables",
              label: t('roles.tablePermission'),
              children: (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Space wrap>
                    <Input.Search
                      allowClear
                      placeholder={t('roles.tableSearchPlaceholder')}
                      value={tablePermissionSearch}
                      onChange={(event) =>
                        setTablePermissionSearch(event.target.value)
                      }
                      style={{ width: 280 }}
                    />
                    <Space>
                      <Switch
                        checked={isVisibleTablePermissionChecked("can_select")}
                        onChange={(checked) =>
                          updateVisibleTablePermissions("can_select", checked)
                        }
                      />
                      <span>{t('roles.allQuery')}</span>
                    </Space>
                    <Space>
                      <Switch
                        checked={isVisibleTablePermissionChecked("can_insert")}
                        onChange={(checked) =>
                          updateVisibleTablePermissions("can_insert", checked)
                        }
                      />
                      <span>{t('roles.allInsert')}</span>
                    </Space>
                    <Space>
                      <Switch
                        checked={isVisibleTablePermissionChecked("can_update")}
                        onChange={(checked) =>
                          updateVisibleTablePermissions("can_update", checked)
                        }
                      />
                      <span>{t('roles.allUpdate')}</span>
                    </Space>
                    <Space>
                      <Switch
                        checked={isVisibleTablePermissionChecked("can_delete")}
                        onChange={(checked) =>
                          updateVisibleTablePermissions("can_delete", checked)
                        }
                      />
                      <span>{t('roles.allDelete')}</span>
                    </Space>
                  </Space>

                  <Table
                    columns={tablePermissionColumns}
                    dataSource={filteredSysTables}
                    rowKey="id"
                    pagination={false}
                    size="small"
                    scroll={{ y: 360 }}
                    locale={{
                      emptyText: (
                        <Empty description={t('roles.emptyTables')} />
                      ),
                    }}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    </Card>
  );
}
