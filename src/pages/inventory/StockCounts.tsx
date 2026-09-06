import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Form, Input, InputNumber, Modal, Select, Space, message, DatePicker, Table } from 'antd';
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { supabase } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import type { Tables } from '../../utils/supabase';
import SimpleModal from '@/components/SimpleModal';
import { SupaModal } from '@/components/SupaModal';

type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];
type Bin = Tables['erp_bins_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Header = { id: number; count_no: string; count_date: string; warehouse_id: number | null; location_id: number | null; remark: string | null; status: string | null; };
type Detail = { id: number; count_id: number; line_no: number; product_id: number | null; location_id: number | null; batch_no: string | null; system_quantity: number | null; counted_quantity: number | null; difference_quantity: number | null; unit_cost: number | null; remark: string | null; };

const tableName = 'erp_stock_counts_s_539dcf81_b';
const detailTable = 'erp_stock_count_details_s_539dcf81_b';

export function StockCounts() {
  const [rows, setRows] = useState<Header[]>([]);
  const [details, setDetails] = useState<Detail[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Header | null>(null);
  const [editing, setEditing] = useState<Header | null>(null);
  const [detailEditing, setDetailEditing] = useState<Detail | null>(null);
  const [open, setOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);

  useEffect(() => { void fetchAll(); }, []);
  const fetchAll = async () => {
    setLoading(true);
    const [{ data: h }, { data: w }, { data: b }, { data: p }] = await Promise.all([
      supabase.from(tableName).select('*').eq('is_deleted', 'n').order('count_date', { ascending: false }),
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
  const fetchDetails = async (id: number) => { const { data } = await supabase.from(detailTable).select('*').eq('is_deleted', 'n').eq('count_id', id).order('line_no'); setDetails((data || []) as Detail[]); };
  const handlePost = async (id: number) => {
    Modal.confirm({
      title: '审核并过账',
      content: '系统会先将该盘点单审核为已批准状态，然后执行过账。是否继续？',
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
            p_document_type: 'stock_count',
            p_document_id: id,
            p_idempotency_key: crypto.randomUUID(),
          });
          if (error) throw error;
          message.success('盘点单已审核并过账');
          await fetchAll();
        } catch (error: any) {
          console.error('Error posting stock count:', error);
          message.error(error?.message || '审核或过账失败');
        }
      },
    });
  };
  const columns = [
    { title: '盘点单号', key: 'count_no', dataIndex: 'count_no' },
    { title: '盘点日期', key: 'count_date', dataIndex: 'count_date' },
    { title: '仓库', key: 'warehouse_id', dataIndex: 'warehouse_id', render: (v: number) => warehouses.find(w => w.id === v)?.name || '-' },
    { title: '库位', key: 'location_id', dataIndex: 'location_id', render: (v: number) => bins.find(b => b.id === v)?.name || '-' },
    { title: '状态', key: 'status', dataIndex: 'status' },
    { title: '操作', key: 'action', render: (_: any, record: Header) => <Space>
      <Button onClick={async () => { setSelected(record); await fetchDetails(record.id); setDetailOpen(true); }}>明细</Button>
      {record.status !== 'posted' && <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void handlePost(record.id)}>{record.status === 'draft' ? '审核并过账' : '过账'}</Button>}
      <Button onClick={() => { setEditing(record); form.setFieldsValue({ ...record, count_date: dayjs(record.count_date) }); setOpen(true); }}>编辑</Button>
      <Button danger icon={<DeleteOutlined />} onClick={async () => { await supabase.from(tableName).update({ is_deleted: 'y' }).eq('id', record.id); await fetchAll(); }}>删除</Button>
    </Space>},
  ];
  return (
    <>
      <SuperTable
        columns={columns}
        dataSource={rows}
        loading={loading}
        rowKey="id"
        storageKey="stock-counts"
        headerTitle="库存盘点"
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              form.setFieldsValue({
                count_no: `SC${Date.now().toString().slice(-8)}`,
                count_date: dayjs(),
                location_id: undefined,
                status: "draft",
              });
              setOpen(true);
            }}
          >
            新增盘点
          </Button>
        }
      />
      <SupaModal
        title={editing ? "编辑盘点" : "新增盘点"}
        open={open}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
        }}
        footer={null}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            const payload = {
              ...values,
              count_date:
                values.count_date?.format?.("YYYY-MM-DD") ?? values.count_date,
            };
            if (editing)
              await supabase
                .from(tableName)
                .update(payload)
                .eq("id", editing.id);
            else await supabase.from(tableName).insert([payload]);
            setOpen(false);
            await fetchAll();
          }}
        >
          <Form.Item
            name="count_no"
            label="盘点单号"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="count_date"
            label="盘点日期"
            rules={[{ required: true }]}
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="warehouse_id"
            label="仓库"
            rules={[{ required: true }]}
          >
            <Select
              options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
              onChange={() => form.setFieldsValue({ location_id: undefined })}
            />
          </Form.Item>
          <Form.Item name="location_id" label="库位">
            <Select
              allowClear
              options={bins
                .filter((b) => b.warehouse_id === form.getFieldValue('warehouse_id'))
                .map((b) => ({ value: b.id, label: `${b.code} ${b.name}` }))}
            />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SupaModal>
      <SimpleModal
        title={`盘点明细 ${selected?.count_no ?? ""}`}
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        width={900}
        footer={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setDetailEditing(null);
              detailForm.setFieldsValue({
                count_id: selected?.id,
                line_no: details.length + 1,
                location_id: selected?.location_id || undefined,
                system_quantity: 0,
                counted_quantity: 0,
                difference_quantity: 0,
                unit_cost: 0,
              });
              setDetailEditing({} as Detail);
            }}
          >
            新增明细
          </Button>
        }
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
            { title: "库位", dataIndex: "location_id", render: (v: number) => bins.find((b) => b.id === v)?.name || "-" },
            { title: "系统数量", dataIndex: "system_quantity" },
            { title: "盘点数量", dataIndex: "counted_quantity" },
            { title: "差异", dataIndex: "difference_quantity" },
          ]}
          pagination={false}
        />
      </SimpleModal>
      <SimpleModal
        title="盘点明细"
        open={!!detailEditing}
        onCancel={() => setDetailEditing(null)}
        onOk={() => detailForm.submit()}
        destroyOnClose
      >
        <Form
          form={detailForm}
          layout="vertical"
          onFinish={async (values) => {
            const payload = {
              ...values,
              batch_no: values.batch_no || null,
              difference_quantity:
                (values.counted_quantity || 0) - (values.system_quantity || 0),
            };
            const { error } = await supabase
              .from(detailTable)
              .insert([payload]);
            if (error) throw error;
            setDetailEditing(null);
            if (selected) await fetchDetails(selected.id);
          }}
        >
          <Form.Item name="count_id" hidden>
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
          <Form.Item name="system_quantity" label="账面数量">
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="location_id" label="库位">
            <Select allowClear options={bins.filter((b) => b.warehouse_id === selected?.warehouse_id).map((b) => ({ value: b.id, label: `${b.code} ${b.name}` }))} />
          </Form.Item>
          <Form.Item
            name="counted_quantity"
            label="盘点数量"
            rules={[{ required: true }]}
          >
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="unit_cost" label="单价">
            <InputNumber style={{ width: "100%" }} />
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
