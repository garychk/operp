import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
interface DictType {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  status: string;
  sort_order: number;
}
interface DictItem {
  id: number;
  type_id: number;
  code: string;
  label: string;
  description?: string | null;
  status: string;
  sort_order: number;
}
export function Dictionaries() {
  const [types, setTypes] = useState<DictType[]>([]),
    [items, setItems] = useState<DictItem[]>([]),
    [selectedType, setSelectedType] = useState<number>(),
    [loading, setLoading] = useState(false),
    [typeModal, setTypeModal] = useState(false),
    [itemModal, setItemModal] = useState(false),
    [editingType, setEditingType] = useState<DictType | null>(null),
    [editingItem, setEditingItem] = useState<DictItem | null>(null);
  const [typeForm] = Form.useForm();
  const [itemForm] = Form.useForm();
  const fetchData = async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        supabase
          .from("sys_dict_types")
          .select("*")
          .eq("is_deleted", "n")
          .order("sort_order")
          .order("id"),
        supabase
          .from("sys_dict_items")
          .select("*")
          .eq("is_deleted", "n")
          .order("sort_order")
          .order("id"),
      ]);
      if (a.error) throw a.error;
      if (b.error) throw b.error;
      setTypes(a.data || []);
      setItems(b.data || []);
      if (!selectedType && a.data?.length) setSelectedType(a.data[0].id);
    } catch {
      message.error("获取数据字典失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchData();
  }, []);
  const save = async (table: string, values: any, id?: number) => {
    try {
      await logWithTiming(
        id ? "更新数据字典" : "创建数据字典",
        id ? "UPDATE" : "INSERT",
        async () => {
          const q = id
            ? supabase.from(table).update(values).eq("id", id)
            : supabase.from(table).insert(values);
          const { error } = await q;
          if (error) throw error;
        },
      );
      message.success(id ? "更新成功" : "创建成功");
      fetchData();
    } catch {
      message.error("保存失败，请检查编码是否重复");
    }
  };
  const remove = async (table: string, id: number) => {
    try {
      const { error } = await supabase
        .from(table)
        .update({ is_deleted: "y" })
        .eq("id", id);
      if (error) throw error;
      message.success("删除成功");
      fetchData();
    } catch {
      message.error("删除失败");
    }
  };
  const status = (v: string) => (
    <Tag color={v === "1" ? "success" : "default"}>
      {v === "1" ? "启用" : "停用"}
    </Tag>
  );
  const typeColumns: ColumnsType<DictType> = [
    { title: "编码", dataIndex: "code" },
    { title: "名称", dataIndex: "name" },
    { title: "排序", dataIndex: "sort_order", width: 70 },
    { title: "状态", dataIndex: "status", width: 80, render: status },
    {
      title: "操作",
      width: 150,
      render: (_, r) => (
        <Space>
          <Button
            size="small"
             type="link"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingType(r);
              typeForm.setFieldsValue(r);
              setTypeModal(true);
            }}
          >
            编辑
          </Button>
          <Popconfirm
            title="确定删除该字典类型吗？"
            onConfirm={() => remove("sys_dict_types", r.id)}
          >
            <Button size="small" danger type="link" icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  const itemColumns: ColumnsType<DictItem> = [
    { title: "编码", dataIndex: "code" },
    { title: "显示名称", dataIndex: "label" },
    { title: "排序", dataIndex: "sort_order", width: 70 },
    { title: "状态", dataIndex: "status", width: 80, render: status },
    {
      title: "操作",
      width: 150,
      render: (_, r) => (
        <Space>
          <Button
            size="small"
             type="link"
            icon={<EditOutlined />}
            onClick={() => {
              setEditingItem(r);
              itemForm.setFieldsValue(r);
              setItemModal(true);
            }}
          >
            编辑
          </Button>
          <Popconfirm
            title="确定删除该字典项吗？"
            onConfirm={() => remove("sys_dict_items", r.id)}
          >
            <Button size="small" danger type="link" icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  const selectedItems = items.filter((i) => i.type_id === selectedType),
    selectedName = types.find((t) => t.id === selectedType)?.name;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(360px,1fr) minmax(520px,1.5fr)",
        gap: 4,
      }}
    >
      <Card
        title="字典类型"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingType(null);
              typeForm.resetFields();
              setTypeModal(true);
            }}
          >
            新增类型
          </Button>
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={typeColumns}
          dataSource={types}
          rowClassName={(r) =>
            r.id === selectedType ? "ant-table-row-selected" : ""
          }
          onRow={(r) => ({ onClick: () => setSelectedType(r.id) })}
          pagination={false}
        />
      </Card>
      <Card
        title={selectedName ? `${selectedName} - 字典项` : "字典项"}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            disabled={!selectedType}
            onClick={() => {
              setEditingItem(null);
              itemForm.resetFields();
              setItemModal(true);
            }}
          >
            新增字典项
          </Button>
        }
      >
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={itemColumns}
          dataSource={selectedItems}
          pagination={{ pageSize: 8 }}
        />
      </Card>
      <Modal
        title={editingType ? "编辑字典类型" : "新增字典类型"}
        open={typeModal}
        onCancel={() => setTypeModal(false)}
        onOk={() => typeForm.submit()}
      >
        <Card size="small">
          <Form
            form={typeForm}
            layout="horizontal"
            labelCol={{ span: 6 }}
            wrapperCol={{ span: 18 }}
            onFinish={(v) => {
              setTypeModal(false);
              save("sys_dict_types", v, editingType?.id);
            }}
          >
            <Form.Item
              name="code"
              label="类型编码"
              rules={[{ required: true }]}
            >
              <Input disabled={!!editingType} />
            </Form.Item>
            <Form.Item
              name="name"
              label="类型名称"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="sort_order" label="排序" initialValue={0}>
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="status" label="状态" initialValue="1">
              <Select
                options={[
                  { value: "1", label: "启用" },
                  { value: "0", label: "停用" },
                ]}
              />
            </Form.Item>
          </Form>
        </Card>
      </Modal>
      <Modal
        title={editingItem ? "编辑字典项" : "新增字典项"}
        open={itemModal}
        onCancel={() => setItemModal(false)}
        onOk={() => itemForm.submit()}
      >
        <Card size="small">
          <Form
            form={itemForm}
            layout="horizontal"
            labelCol={{ span: 6 }}
            wrapperCol={{ span: 18 }}
            onFinish={(v) => {
              setItemModal(false);
              save(
                "sys_dict_items",
                { ...v, type_id: selectedType },
                editingItem?.id,
              );
            }}
          >
            <Form.Item name="code" label="字典值" rules={[{ required: true }]}>
              <Input disabled={!!editingItem} />
            </Form.Item>
            <Form.Item
              name="label"
              label="显示名称"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item name="sort_order" label="排序" initialValue={0}>
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="status" label="状态" initialValue="1">
              <Select
                options={[
                  { value: "1", label: "启用" },
                  { value: "0", label: "停用" },
                ]}
              />
            </Form.Item>
          </Form>
        </Card>
      </Modal>
    </div>
  );
}
