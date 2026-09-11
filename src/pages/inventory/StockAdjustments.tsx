import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Form, Input, InputNumber, Modal, Select, Space, message, DatePicker, Table } from 'antd';
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import { SuperTable } from '../../components/SuperTable';
import type { Tables } from '../../utils/supabase';
import SimpleModal from '../../components/SimpleModal';

type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];
type Bin = Tables['erp_bins_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Header = { id: number; adjust_no: string; adjust_date: string; warehouse_id: number | null; location_id: number | null; reason: string | null; remark: string | null; status: string | null; };
type Detail = { id: number; adjust_id: number; line_no: number; product_id: number | null; location_id: number | null; batch_no: string | null; direction: string | null; quantity: number | null; unit_cost: number | null; remark: string | null; };

const tableName = 'erp_stock_adjustments_s_539dcf81_b';
const detailTable = 'erp_stock_adjustment_details_s_539dcf81_b';

export function StockAdjustments() {
  const { t } = useTranslation();
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
      supabase.from(tableName).select('*').eq('is_deleted', 'n').order('adjust_date', { ascending: false }),
      supabase.from('erp_warehouses_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active'),
      supabase.from('erp_bins_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active'),
      supabase.from('erp_products_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active'),
    ]);
    setRows((h || []) as Header[]); setWarehouses((w || []) as Warehouse[]); setBins((b || []) as Bin[]); setProducts((p || []) as Product[]); setLoading(false);
  };
  const fetchDetails = async (id: number) => { const { data } = await supabase.from(detailTable).select('*').eq('is_deleted', 'n').eq('adjust_id', id).order('line_no'); setDetails((data || []) as Detail[]); };
  const handlePost = async (id: number) => {
    Modal.confirm({
      title: t('stockAdjustments.approveAndPost'),
      content: t('stockAdjustments.postConfirmContent'),
      okText: t('stockAdjustments.continue'),
      cancelText: t('common.cancel'),
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
          message.success(t('stockAdjustments.messages.postSuccess'));
          await fetchAll();
        } catch (error: any) {
          console.error('Error posting stock adjustment:', error);
          message.error(error?.message || t('stockAdjustments.messages.postFailed'));
        }
      },
    });
  };
  const columns = [
    { title: t('stockAdjustments.adjustNo'), key: 'adjust_no', dataIndex: 'adjust_no' },
    { title: t('stockAdjustments.date'), key: 'adjust_date', dataIndex: 'adjust_date' },
    { title: t('stockAdjustments.warehouse'), key: 'warehouse_id', dataIndex: 'warehouse_id', render: (v: number) => warehouses.find(w => w.id === v)?.name || '-' },
    { title: t('stockAdjustments.bin'), key: 'location_id', dataIndex: 'location_id', render: (v: number) => bins.find(b => b.id === v)?.name || '-' },
    { title: t('stockAdjustments.reason'), key: 'reason', dataIndex: 'reason' },
    { title: t('common.status'), key: 'status', dataIndex: 'status' },
    { title: t('common.actions'), key: 'action', render: (_: any, record: Header) => <Space>
      <Button onClick={async () => { setSelected(record); await fetchDetails(record.id); setDetailOpen(true); }}>{t('stockAdjustments.detail')}</Button>
      {record.status !== 'posted' && <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void handlePost(record.id)}>{record.status === 'draft' ? t('stockAdjustments.approveAndPost') : t('stockAdjustments.post')}</Button>}
      <Button onClick={() => { setEditing(record); form.setFieldsValue({ ...record, adjust_date: dayjs(record.adjust_date) }); setOpen(true); }}>{t('common.edit')}</Button>
      <Button danger icon={<DeleteOutlined />} onClick={async () => { await supabase.from(tableName).update({ is_deleted: 'y' }).eq('id', record.id); await fetchAll(); }}>{t('common.delete')}</Button>
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
        headerTitle={t('stockAdjustments.title')}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={async () => {
              setEditing(null);
              form.setFieldsValue({
                adjust_no: await nextDocumentNo('stock_adjustment'),
                adjust_date: dayjs(),
                location_id: undefined,
                status: "draft",
              });
              setOpen(true);
            }}
          >
            {t('stockAdjustments.add')}
          </Button>
        }
      />
      <SimpleModal
        title={editing ? t('stockAdjustments.editTitle') : t('stockAdjustments.add')}
        open={open}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
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
            label={t('stockAdjustments.adjustNo')}
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="adjust_date"
            label={t('stockAdjustments.adjustDate')}
            rules={[{ required: true }]}
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="warehouse_id"
            label={t('stockAdjustments.warehouse')}
            rules={[{ required: true }]}
          >
            <Select
              options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
              onChange={() => form.setFieldsValue({ location_id: undefined })}
            />
          </Form.Item>
          <Form.Item name="location_id" label={t('stockAdjustments.bin')}>
            <Select
              allowClear
              options={bins.filter((b) => b.warehouse_id === form.getFieldValue('warehouse_id')).map((b) => ({ value: b.id, label: `${b.code} ${b.name}` }))}
            />
          </Form.Item>
          <Form.Item name="reason" label={t('stockAdjustments.adjustReason')}>
            <Input />
          </Form.Item>
          <Form.Item name="remark" label={t('stockAdjustments.remark')}>
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
      <SimpleModal
        title={`${t('stockAdjustments.detailTitle')} ${selected?.adjust_no ?? ""}`}
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
                location_id: selected?.location_id || undefined,
                direction: "in",
                quantity: 1,
                unit_cost: 0,
              });
              setDetailEditing({} as Detail);
            }}
          >
            {t('stockAdjustments.addDetail')}
          </Button>
        }
        width={900}
      >
        <Table
          style={{ marginTop: 16 }}
          rowKey="id"
          dataSource={details}
          columns={[
            { title: t('stockAdjustments.lineNo'), dataIndex: "line_no" },
            {
              title: t('stockAdjustments.product'),
              dataIndex: "product_id",
              render: (v: number) =>
                products.find((p) => p.id === v)?.name || "-",
            },
            { title: t('stockAdjustments.bin'), dataIndex: "location_id", render: (v: number) => bins.find((b) => b.id === v)?.name || "-" },
            { title: t('stockAdjustments.direction'), dataIndex: "direction" },
            { title: t('stockAdjustments.quantity'), dataIndex: "quantity" },
            { title: t('stockAdjustments.batchNo'), dataIndex: "batch_no" },
          ]}
          pagination={false}
        />
      </SimpleModal>
      <SimpleModal
        title={t('stockAdjustments.detailTitle')}
        open={!!detailEditing}
        onCancel={() => setDetailEditing(null)}
        onOk={() => detailForm.submit()}
        destroyOnHidden
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
          <Form.Item name="line_no" label={t('stockAdjustments.lineNo')}>
            <InputNumber style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="product_id"
            label={t('stockAdjustments.product')}
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
          <Form.Item name="direction" label={t('stockAdjustments.direction')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: "in", label: t('stockAdjustments.directionIn') },
                { value: "out", label: t('stockAdjustments.directionOut') },
              ]}
            />
          </Form.Item>
          <Form.Item name="location_id" label={t('stockAdjustments.bin')}>
            <Select allowClear options={bins.filter((b) => b.warehouse_id === selected?.warehouse_id).map((b) => ({ value: b.id, label: `${b.code} ${b.name}` }))} />
          </Form.Item>
          <Form.Item name="quantity" label={t('stockAdjustments.quantity')} rules={[{ required: true }]}>
            <InputNumber style={{ width: "100%" }} min={0.0001} />
          </Form.Item>
          <Form.Item name="unit_cost" label={t('stockAdjustments.unitCost')}>
            <InputNumber style={{ width: "100%" }} min={0} />
          </Form.Item>
          <Form.Item name="batch_no" label={t('stockAdjustments.batchNo')}>
            <Input />
          </Form.Item>
          <Form.Item name="remark" label={t('stockAdjustments.remark')}>
            <Input.TextArea />
          </Form.Item>
        </Form>
      </SimpleModal>
    </>
  );
}
