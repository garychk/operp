import { useState, useEffect } from "react";
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
      message.error("获取角色列表失败");
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
      message.error("获取菜单列表失败");
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
      message.error("获取角色权限失败");
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
      message.error("获取数据表列表失败");
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
      message.error("获取表权限失败");
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
      await logWithTiming("删除角色", "DELETE", async () => {
        const { error } = await supabase
          .from("sys_roles")
          .update({ is_deleted: "y" })
          .eq("id", id);
        if (error) throw error;
      });
      message.success("删除成功");
      fetchRoles();
    } catch (error) {
      message.error("删除失败");
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

      message.success("权限设置成功");
      setPermissionModalVisible(false);
    } catch (error) {
      message.error("权限设置失败");
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
        message.success("更新成功");
      } else {
        const { error } = await supabase.from("sys_roles").insert([values]);
        if (error) throw error;
        message.success("创建成功");
      }
      setModalVisible(false);
      fetchRoles();
    } catch (error) {
      message.error("保存失败");
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
      title: "模块",
      dataIndex: "module_name",
      width: 120,
      render: (moduleName) => <Tag>{moduleName}</Tag>,
    },
    {
      title: "数据表",
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
      title: "查询",
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
      title: "新增",
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
      title: "修改",
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
      title: "删除",
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
      title: "角色编码",
      dataIndex: "role_code",
      width: 200,
    },
    {
      title: "角色名称",
      dataIndex: "role_name",
      width: 150,
    },
    {
      title: "描述",
      dataIndex: "description",
      ellipsis: true,
    },
    {
      title: "排序",
      dataIndex: "sort_order",
      width: 80,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (status) => (
        <Tag color={status === "1" ? "success" : "error"}>
          {status === "1" ? "启用" : "禁用"}
        </Tag>
      ),
    },
    {
      title: "创建时间",
      dataIndex: "created_at",
      width: 180,
      render: (date) => new Date(date).toLocaleString(),
    },
    {
      title: "操作",
      key: "action",
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Button
            type="primary"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          >
            编辑
          </Button>
          <Button
            icon={<SafetyOutlined />}
            onClick={() => handlePermission(record)}
          >
            权限
          </Button>
          <Popconfirm
            title="确定删除吗？"
            onConfirm={() => handleDelete(record.id)}
          >
            <Button danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      className="mainContent"
      variant="borderless"
      title="角色管理"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          新增角色
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
      <Modal
        title={editingRole ? "编辑角色" : "新增角色"}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        width={400}
      >
        <Card size="small">
          <Form
            form={form}
            layout="horizontal"
            labelCol={{ span: 6 }}
            wrapperCol={{ span: 18 }}
            onFinish={handleSave}            
          >
            <Form.Item
              name="role_code"
              label="角色编码"
              rules={[{ required: true }]}
            >
              <Input disabled={!!editingRole} />
            </Form.Item>
            <Form.Item
              name="role_name"
              label="角色名称"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="sort_order" label="排序" initialValue={0}>
              <InputNumber />
            </Form.Item>
            <Form.Item name="status" label="状态" initialValue="1">
              <Select>
                <Select.Option value="1">启用</Select.Option>
                <Select.Option value="0">禁用</Select.Option>
              </Select>
            </Form.Item>
          </Form>
        </Card>
      </Modal>
      <Modal
        title="设置权限"
        open={permissionModalVisible}
        onCancel={() => setPermissionModalVisible(false)}
        onOk={handleSavePermission}
        width={820}
      >
        <Tabs
          items={[
            {
              key: "menus",
              label: "菜单权限",
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
              label: "表权限",
              children: (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                  <Space wrap>
                    <Input.Search
                      allowClear
                      placeholder="根据表名、别名搜索"
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
                      <span>全部查询</span>
                    </Space>
                    <Space>
                      <Switch
                        checked={isVisibleTablePermissionChecked("can_insert")}
                        onChange={(checked) =>
                          updateVisibleTablePermissions("can_insert", checked)
                        }
                      />
                      <span>全部新增</span>
                    </Space>
                    <Space>
                      <Switch
                        checked={isVisibleTablePermissionChecked("can_update")}
                        onChange={(checked) =>
                          updateVisibleTablePermissions("can_update", checked)
                        }
                      />
                      <span>全部修改</span>
                    </Space>
                    <Space>
                      <Switch
                        checked={isVisibleTablePermissionChecked("can_delete")}
                        onChange={(checked) =>
                          updateVisibleTablePermissions("can_delete", checked)
                        }
                      />
                      <span>全部删除</span>
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
                        <Empty description="暂无可配置表，请先执行 007_create_role_table_permissions.sql 初始化 sys_tables" />
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
