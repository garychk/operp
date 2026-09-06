import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { supabase } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import SimpleModal from "../../components/SimpleModal";

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
  const { t } = useTranslation();
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
      message.error(t('dictionaries.fetchFailed'));
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
        id ? t('dictionaries.logUpdate') : t('dictionaries.logCreate'),
        id ? "UPDATE" : "INSERT",
        async () => {
          const q = id
            ? supabase.from(table).update(values).eq("id", id)
            : supabase.from(table).insert(values);
          const { error } = await q;
          if (error) throw error;
        },
      );
      message.success(
        id ? t('common.updateSuccess') : t('dictionaries.createSuccess'),
      );
      fetchData();
    } catch {
      message.error(t('dictionaries.saveFailedDuplicateCode'));
    }
  };
  const remove = async (table: string, id: number) => {
    try {
      const { error } = await supabase
        .from(table)
        .update({ is_deleted: "y" })
        .eq("id", id);
      if (error) throw error;
      message.success(t('common.deleteSuccess'));
      fetchData();
    } catch {
      message.error(t('common.deleteFailed'));
    }
  };
  const status = (v: string) => (
    <Tag color={v === "1" ? "success" : "default"}>
      {v === "1" ? t('common.enabled') : t('dictionaries.disabled')}
    </Tag>
  );
  const typeColumns: ColumnsType<DictType> = [
    { title: t('common.code'), dataIndex: "code" },
    { title: t('common.name'), dataIndex: "name" },
    { title: t('dictionaries.sort'), dataIndex: "sort_order", width: 100 },
    { title: t('common.status'), dataIndex: "status", width: 80, render: status },
    {
      title: t('common.actions'),
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
            {t('common.edit')}
          </Button>
          <Popconfirm
            title={t('dictionaries.confirmDeleteType')}
            onConfirm={() => remove("sys_dict_types", r.id)}
          >
            <Button size="small" danger type="link" icon={<DeleteOutlined />}>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
  const itemColumns: ColumnsType<DictItem> = [
    { title: t('common.code'), dataIndex: "code" },
    { title: t('dictionaries.displayName'), dataIndex: "label" },
    { title: t('dictionaries.sort'), dataIndex: "sort_order", width: 100 },
    { title: t('common.status'), dataIndex: "status", width: 80, render: status },
    {
      title: t('common.actions'),
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
            {t('common.edit')}
          </Button>
          <Popconfirm
            title={t('dictionaries.confirmDeleteItem')}
            onConfirm={() => remove("sys_dict_items", r.id)}
          >
            <Button size="small" danger type="link" icon={<DeleteOutlined />}>
              {t('common.delete')}
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
        className='mainContent'
        title={t('dictionaries.dictTypeTitle')}
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
            {t('dictionaries.addType')}
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
        title={
          selectedName
            ? t('dictionaries.dictItemsWithName', { name: selectedName })
            : t('dictionaries.dictItemTitle')
        }
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
            {t('dictionaries.addItem')}
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
      <SimpleModal
        title={
          editingType
            ? t('dictionaries.editDictType')
            : t('dictionaries.addDictType')
        }
        open={typeModal}
        onCancel={() => setTypeModal(false)}
        onOk={() => typeForm.submit()}
      >
        <Card size="small">
          <Form
            form={typeForm}
            layout="vertical"
            onFinish={(v) => {
              setTypeModal(false);
              save("sys_dict_types", v, editingType?.id);
            }}
          >
            <Form.Item
              name="code"
              label={t('dictionaries.typeCode')}
              rules={[{ required: true }]}
            >
              <Input disabled={!!editingType} />
            </Form.Item>
            <Form.Item
              name="name"
              label={t('dictionaries.typeName')}
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="description" label={t('dictionaries.description')}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item
              name="sort_order"
              label={t('dictionaries.sort')}
              initialValue={0}
            >
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="status" label={t('common.status')} initialValue="1">
              <Select
                options={[
                  { value: "1", label: t('common.enabled') },
                  { value: "0", label: t('dictionaries.disabled') },
                ]}
              />
            </Form.Item>
          </Form>
        </Card>
      </SimpleModal>
      <SimpleModal
        title={
          editingItem ? t('dictionaries.editItem') : t('dictionaries.addItem')
        }
        open={itemModal}
        onCancel={() => setItemModal(false)}
        onOk={() => itemForm.submit()}
      >
        <Card size="small">
          <Form
            form={itemForm}
            layout="vertical"
            onFinish={(v) => {
              setTypeModal(false);
              save(
                "sys_dict_items",
                { ...v, type_id: selectedType },
                editingItem?.id,
              );
            }}
          >
            <Form.Item
              name="code"
              label={t('dictionaries.dictValue')}
              rules={[{ required: true }]}
            >
              <Input disabled={!!editingItem} />
            </Form.Item>
            <Form.Item
              name="label"
              label={t('dictionaries.displayName')}
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="description" label={t('dictionaries.description')}>
              <Input.TextArea rows={2} />
            </Form.Item>
            <Form.Item
              name="sort_order"
              label={t('dictionaries.sort')}
              initialValue={0}
            >
              <InputNumber min={0} />
            </Form.Item>
            <Form.Item name="status" label={t('common.status')} initialValue="1">
              <Select
                options={[
                  { value: "1", label: t('common.enabled') },
                  { value: "0", label: t('dictionaries.disabled') },
                ]}
              />
            </Form.Item>
          </Form>
        </Card>
      </SimpleModal>
    </div>
  );
}
