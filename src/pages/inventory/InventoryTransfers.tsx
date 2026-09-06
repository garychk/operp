import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Form, Input, InputNumber, Modal, Select, Space, message, DatePicker, Table } from 'antd';
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { supabase } from '@/utils/supabase';
import { logWithTiming } from '@/utils/logger';
import { SuperTable } from '@/components/SuperTable';
import type { Tables } from '@/utils/supabase';
import SimpleModal from '@/components/SimpleModal';
import { SupaModal } from '@/components/SupaModal';

type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];
type Bin = Tables['erp_bins_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Row = {
  id: number;
  transfer_id: number;
  line_no: number;
  product_id: number | null;
  from_location_id: number | null;
  to_location_id: number | null;
  quantity: number | null;
  unit_cost: number | null;
  batch_no: string | null;
  remark: string | null;
};
type Header = {
  id: number;
  transfer_no: string;
  transfer_date: string;
  from_warehouse_id: number | null;
  to_warehouse_id: number | null;
  remark: string | null;
  status: string | null;
};

const tableName = 'erp_inventory_transfers_s_539dcf81_b';
const detailTable = 'erp_inventory_transfer_details_s_539dcf81_b';

export function InventoryTransfers() {
  const [rows, setRows] = useState<Header[]>([]);
  const [details, setDetails] = useState<Row[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Header | null>(null);
  const [editing, setEditing] = useState<Header | null>(null);
  const [open, setOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailFormOpen, setDetailFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);

  useEffect(() => { void fetchAll(); }, []);

  const fetchAll = async () => {
    setLoading(true);
    const [{ data: h }, { data: w }, { data: b }, { data: p }] = await Promise.all([
      supabase.from(tableName).select('*').eq('is_deleted', 'n').order('transfer_date', { ascending: false }),
      supabase.from('erp_warehouses_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active'),
      supabase.from('erp_bins_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active'),
      supabase.from('erp_products_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active'),
    ]);
    setRows((h || []) as Header[]);
    setWarehouses((w || []) as Warehouse[]);
    setBins((b || []) as Bin[]);
    setProducts((p || []) as Product[]);
    setLoading(false);
  };

  const fetchDetails = async (id: number) => {
    const { data } = await supabase.from(detailTable).select('*').eq('is_deleted', 'n').eq('transfer_id', id).order('line_no');
    setDetails((data || []) as Row[]);
  };

  const handleSubmit = async (values: any) => {
    const payload = { ...values, transfer_date: values.transfer_date?.format?.('YYYY-MM-DD') ?? values.transfer_date };
    if (editing) {
      await logWithTiming('更新库存调拨', 'UPDATE', async () => {
        const { error } = await supabase.from(tableName).update(payload).eq('id', editing.id);
        if (error) throw error;
      }, { table: tableName, recordId: editing.id });
    } else {
      const { data, error } = await supabase.from(tableName).insert([payload]).select().single();
      if (error) throw error;
      setSelected(data as Header);
    }
    setOpen(false); setEditing(null); form.resetFields(); await fetchAll();
  };

  const handlePost = async (id: number) => {
    Modal.confirm({
      title: '审核并过账',
      content: '系统会先将该调拨单审核为已批准状态，然后执行过账。是否继续？',
      okText: '继续',
      cancelText: '取消',
      onOk: async () => {
        try {
          const approvedAt = new Date().toISOString();
          const { error: approveError } = await supabase
            .from(tableName)
            .update({ status: 'approved', approved_at: approvedAt })
            .eq('id', id);
          if (approveError) throw approveError;

          const { error } = await supabase.rpc('post_inventory_document', {
            p_document_type: 'inventory_transfer',
            p_document_id: id,
            p_idempotency_key: crypto.randomUUID(),
          });
          if (error) throw error;
          message.success('调拨单已审核并过账');
          await fetchAll();
        } catch (error: any) {
          console.error('Error posting transfer:', error);
          message.error(error?.message || '审核或过账失败');
        }
      },
    });
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      onOk: async () => {
        const { error } = await supabase.from(tableName).update({ is_deleted: 'y' }).eq('id', id);
        if (error) throw error;
        await fetchAll();
      },
    });
  };

  const columns = [
    { title: '调拨单号', key: 'transfer_no', dataIndex: 'transfer_no' },
    { title: '日期', key: 'transfer_date', dataIndex: 'transfer_date' },
    { title: '调出仓', key: 'from_warehouse_id', dataIndex: 'from_warehouse_id', render: (v: number) => warehouses.find(w => w.id === v)?.name || '-' },
    { title: '调入仓', key: 'to_warehouse_id', dataIndex: 'to_warehouse_id', render: (v: number) => warehouses.find(w => w.id === v)?.name || '-' },
    { title: '状态', key: 'status', dataIndex: 'status' },
    { title: '操作', key: 'action', render: (_: any, record: Header) => (
      <Space>
        <Button onClick={async () => { setSelected(record); await fetchDetails(record.id); setDetailOpen(true); }}>明细</Button>
        {record.status !== 'posted' && <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void handlePost(record.id)}>{record.status === 'draft' ? '审核并过账' : '过账'}</Button>}
        <Button onClick={() => { setEditing(record); form.setFieldsValue({ ...record, transfer_date: dayjs(record.transfer_date) }); setOpen(true); }}>编辑</Button>
        <Button danger icon={<DeleteOutlined />} onClick={() => void handleDelete(record.id)}>删除</Button>
      </Space>
    )},
  ];

  return (
    <>
      <SuperTable
        columns={columns}
        dataSource={rows}
        loading={loading}
        rowKey="id"
        storageKey="inventory-transfers"
        headerTitle="库存调拨"
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                form.setFieldsValue({
                  transfer_no: `TR${Date.now().toString().slice(-8)}`,
                  transfer_date: dayjs(),
                  status: "draft",
                });
                setOpen(true);
              }}
            >
              新增调拨
            </Button>
          </Space>
        }
      />
      <SimpleModal
        title={editing ? "编辑调拨" : "新增调拨"}
        open={open}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="transfer_no"
            label="调拨单号"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="transfer_date"
            label="调拨日期"
            rules={[{ required: true }]}
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="from_warehouse_id"
            label="调出仓库"
            rules={[{ required: true }]}
          >
            <Select
              options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
            />
          </Form.Item>
          <Form.Item
            name="to_warehouse_id"
            label="调入仓库"
            rules={[{ required: true }]}
          >
            <Select
              options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
            />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
      <SimpleModal
        title={`调拨明细 ${selected?.transfer_no ?? ""}`}
        open={detailOpen}
        onCancel={() => {
          setDetailOpen(false);
          setDetailFormOpen(false);
        }}
        footer={<Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            if (!selected) {
              message.warning("请先选择调拨单");
              return;
            }
            detailForm.setFieldsValue({
              transfer_id: selected.id,
              line_no: details.length + 1,
              quantity: 1,
              unit_cost: 0,
              batch_no: "",
              remark: "",
            });
            setDetailFormOpen(true);
          }}
        >
          新增明细
        </Button>}
        width={900}
      >
        
        <Table
          style={{ marginTop: 16 }}
          rowKey="id"
          dataSource={details}
          columns={[
            { title: "行号", dataIndex: "line_no" },
            {
              title: "物料",
              dataIndex: "product_id",
              render: (v: number) =>
                products.find((p) => p.id === v)?.name || "-",
            },
            {
              title: "调出库位",
              dataIndex: "from_location_id",
              render: (v: number) => bins.find((b) => b.id === v)?.name || "-",
            },
            {
              title: "调入库位",
              dataIndex: "to_location_id",
              render: (v: number) => bins.find((b) => b.id === v)?.name || "-",
            },
            { title: "数量", dataIndex: "quantity" },
            { title: "批次", dataIndex: "batch_no" },
            { title: "成本", dataIndex: "unit_cost" },
          ]}
          pagination={false}
        />
      </SimpleModal>
      <SimpleModal
        title="调拨明细"
        open={detailFormOpen}
        onCancel={() => {
          setDetailFormOpen(false);
        }}
        onOk={() => detailForm.submit()}
        destroyOnHidden
      >
        <Form
          form={detailForm}
          layout="vertical"
          onFinish={async (values) => {
            const payload = { ...values, batch_no: values.batch_no || null };
            const { error } = await supabase
              .from(detailTable)
              .insert([payload]);
            if (error) throw error;
            setDetailFormOpen(false);
            if (selected) await fetchDetails(selected.id);
          }}
        >
          <Form.Item name="transfer_id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="line_no" label="行号">
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="product_id"
            label="物料"
            rules={[{ required: true }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              options={products.map((p) => ({
                value: p.id,
                label: `${p.code} ${p.name}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="from_location_id" label="调出库位">
            <Select
              allowClear
              options={bins
                .filter((b) => b.warehouse_id === selected?.from_warehouse_id)
                .map((b) => ({ value: b.id, label: `${b.code} ${b.name}` }))}
            />
          </Form.Item>
          <Form.Item name="to_location_id" label="调入库位">
            <Select
              allowClear
              options={bins
                .filter((b) => b.warehouse_id === selected?.to_warehouse_id)
                .map((b) => ({ value: b.id, label: `${b.code} ${b.name}` }))}
            />
          </Form.Item>
          <Form.Item name="quantity" label="数量" rules={[{ required: true }]}>
            <InputNumber style={{ width: "100%" }} min={0.0001} />
          </Form.Item>
          <Form.Item name="unit_cost" label="单价">
            <InputNumber style={{ width: "100%" }} min={0} />
          </Form.Item>
          <Form.Item name="batch_no" label="批次">
            <Input />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
    </>
  );
}
