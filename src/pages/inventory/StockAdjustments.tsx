import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Form, Input, InputNumber, Modal, Select, Space, message, DatePicker, Table } from 'antd';
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { supabase } from '@/utils/supabase';
import { SuperTable } from '@/components/SuperTable';
import type { Tables } from '@/utils/supabase';
import SimpleModal from '@/components/SimpleModal';

type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Header = { id: number; adjust_no: string; adjust_date: string; warehouse_id: number | null; reason: string | null; remark: string | null; status: string | null; };
type Detail = { id: number; adjust_id: number; line_no: number; product_id: number | null; batch_no: string | null; direction: string | null; quantity: number | null; unit_cost: number | null; remark: string | null; };

const tableName = 'erp_stock_adjustments_s_539dcf81_b';
const detailTable = 'erp_stock_adjustment_details_s_539dcf81_b';

export function StockAdjustments() {
  const [rows, setRows] = useState<Header[]>([]);
  const [details, setDetails] = useState<Detail[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
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
    const [{ data: h }, { data: w }, { data: p }] = await Promise.all([
      supabase.from(tableName).select('*').eq('is_deleted', 'n').order('adjust_date', { ascending: false }),
      supabase.from('erp_warehouses_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active'),
      supabase.from('erp_products_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active'),
    ]);
    setRows((h || []) as Header[]); setWarehouses((w || []) as Warehouse[]); setProducts((p || []) as Product[]); setLoading(false);
  };
  const fetchDetails = async (id: number) => { const { data } = await supabase.from(detailTable).select('*').eq('is_deleted', 'n').eq('adjust_id', id).order('line_no'); setDetails((data || []) as Detail[]); };
  const handlePost = async (id: number) => {
    Modal.confirm({
      title: '审核并过账',
      content: '系统会先将该库存调整单审核为已批准状态，然后执行过账。是否继续？',
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
            p_document_type: 'stock_adjustment',
            p_document_id: id,
            p_idempotency_key: crypto.randomUUID(),
          });
          if (error) throw error;
          message.success('库存调整单已审核并过账');
          await fetchAll();
        } catch (error: any) {
          console.error('Error posting stock adjustment:', error);
          message.error(error?.message || '审核或过账失败');
        }
      },
    });
  };
  const columns = [
    { title: '调整单号', key: 'adjust_no', dataIndex: 'adjust_no' },
    { title: '日期', key: 'adjust_date', dataIndex: 'adjust_date' },
    { title: '仓库', key: 'warehouse_id', dataIndex: 'warehouse_id', render: (v: number) => warehouses.find(w => w.id === v)?.name || '-' },
    { title: '原因', key: 'reason', dataIndex: 'reason' },
    { title: '状态', key: 'status', dataIndex: 'status' },
    { title: '操作', key: 'action', render: (_: any, record: Header) => <Space>
      <Button onClick={async () => { setSelected(record); await fetchDetails(record.id); setDetailOpen(true); }}>明细</Button>
      {record.status !== 'posted' && <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void handlePost(record.id)}>{record.status === 'draft' ? '审核并过账' : '过账'}</Button>}
      <Button onClick={() => { setEditing(record); form.setFieldsValue({ ...record, adjust_date: dayjs(record.adjust_date) }); setOpen(true); }}>编辑</Button>
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
        storageKey="stock-adjustments"
        headerTitle="库存调整"
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              form.setFieldsValue({
                adjust_no: `SA${Date.now().toString().slice(-8)}`,
                adjust_date: dayjs(),
                status: "draft",
              });
              setOpen(true);
            }}
          >
            新增调整
          </Button>
        }
      />
      <SimpleModal
        title={editing ? "编辑调整" : "新增调整"}
        open={open}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values) => {
            const payload = {
              ...values,
              adjust_date:
                values.adjust_date?.format?.("YYYY-MM-DD") ??
                values.adjust_date,
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
            name="adjust_no"
            label="调整单号"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="adjust_date"
            label="调整日期"
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
            />
          </Form.Item>
          <Form.Item name="reason" label="调整原因">
            <Input />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
      <SimpleModal
        title={`调整明细 ${selected?.adjust_no ?? ""}`}
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setDetailEditing(null);
              detailForm.setFieldsValue({
                adjust_id: selected?.id,
                line_no: details.length + 1,
                direction: "in",
                quantity: 1,
                unit_cost: 0,
              });
              setDetailEditing({} as Detail);
            }}
          >
            新增明细
          </Button>
        }
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
            { title: "方向", dataIndex: "direction" },
            { title: "数量", dataIndex: "quantity" },
            { title: "批次", dataIndex: "batch_no" },
          ]}
          pagination={false}
        />
      </SimpleModal>
      <SimpleModal
        title="调整明细"
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
              direction: values.direction || "in",
            };
            const { error } = await supabase
              .from(detailTable)
              .insert([payload]);
            if (error) throw error;
            setDetailEditing(null);
            if (selected) await fetchDetails(selected.id);
          }}
        >
          <Form.Item name="adjust_id" hidden>
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
          <Form.Item name="direction" label="方向" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "in", label: "入库增加" },
                { value: "out", label: "出库减少" },
              ]}
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
