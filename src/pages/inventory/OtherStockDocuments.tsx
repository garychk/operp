import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Col, Form, Input, InputNumber, Modal, Row, Select, Space, message, DatePicker, Table, Tag } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import { voucherNotice, type InventoryVoucherResult } from '../../utils/inventoryVoucher';
import { useCurrencyRegistry } from '../../utils/money';
import { SuperTable } from '../../components/SuperTable';
import SimpleModal from '../../components/SimpleModal';
import { SupaModal, buildModalNav } from '../../components/SupaModal';
import { WarehouseBinSelect } from '../../components/WarehouseBinSelect';
import { logOperation } from '../../utils/logger';

// ============================================================================
// 其他出入库单（deploy_104 / deploy_105）
//
// 与「库存调整」的关键区别（也是这个页面存在的理由）：
//   1. 方向在**表头**（明细行一律跟随），调整单是明细行各自带方向；
//   2. 有**业务类型**，它决定交易类型、进而决定**对方科目**：
//        报废 → 6711 营业外支出   损耗 → 6602 管理费用
//        借出/赠出/样品 → 1901 待处理财产损溢
//      调整单的对方科目固定是 1901，报废和损耗在账上区分不开。
//   3. 入库必须填单价（或该物料已有有成本库存），否则过账会被拒 ——
//      0 成本入库会把移动加权单价永久拉低且不报错。
// ============================================================================

type Warehouse = { id: number; code: string; name: string };
type Bin = { id: number; code: string; name: string; warehouse_id: number | null };
type Product = { id: number; code: string; name: string; unit: string | null };
type Header = {
  id: number;
  document_no: string;
  document_date: string;
  direction: string;
  business_type: string;
  warehouse_id: number;
  location_id: number | null;
  counterparty: string | null;
  reason: string | null;
  remark: string | null;
  total_cost: number | null;
  status: string | null;
};
type Detail = {
  id: number;
  document_id: number;
  line_no: number;
  product_id: number | null;
  quantity: number | null;
  unit_cost: number | null;
  location_id: number | null;
  batch_no: string | null;
  expiry_date: string | null;
  stock_status: string | null;
  remark: string | null;
};

const tableName = 'erp_other_stock_documents_s_539dcf81_b';
const detailTable = 'erp_other_stock_document_details_s_539dcf81_b';

/** 入库可选业务类型 */
const IN_TYPES = ['overturn', 'lending_return', 'other'] as const;
/** 出库可选业务类型 */
const OUT_TYPES = ['gift', 'sample', 'lending', 'scrap', 'loss', 'other'] as const;

const STATUS_OPTIONS = ['available', 'inspection', 'hold', 'rejected'] as const;

export function OtherStockDocuments() {
  const { t } = useTranslation();
  const { formatMoney, formatQuantity } = useCurrencyRegistry();
  const [rows, setRows] = useState<Header[]>([]);
  const [details, setDetails] = useState<Detail[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Header | null>(null);
  const [detailEditing, setDetailEditing] = useState<Detail | null>(null);
  const [open, setOpen] = useState(false);
  /** 「明细」入口进来时只读；「编辑」入口可改。已过账单据一律只读。 */
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [posting, setPosting] = useState(false);

  const isLocked = readOnly || selected?.status === 'posted';

  // 库位下拉依赖当前仓库；Form.useWatch 让仓库变化时触发重渲染（getFieldValue 不会）
  const headerWarehouseId = Form.useWatch('warehouse_id', form);

  /**
   * 仓库切换：清空原库位（跨仓库的旧库位必然失效），
   * 若新仓库恰好只有一个启用库位则自动带出，多个则留空让人选。
   */
  const handleWarehouseChange = (warehouseId: number) => {
    const candidates = bins.filter((b) => b.warehouse_id === warehouseId);
    form.setFieldsValue({
      location_id: candidates.length === 1 ? candidates[0].id : undefined,
    });
  };

  useEffect(() => {
    void fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    const [{ data: h }, { data: w }, { data: b }, { data: p }] = await Promise.all([
      supabase.from(tableName).select('*').eq('is_deleted', 'n').order('document_date', { ascending: false }),
      supabase.from('erp_warehouses_s_539dcf81_b').select('id,code,name').eq('is_deleted', 'n').eq('status', 'active'),
      supabase.from('erp_bins_s_539dcf81_b').select('id,code,name,warehouse_id').eq('is_deleted', 'n').eq('status', 'active'),
      supabase.from('erp_products_s_539dcf81_b').select('id,code,name,unit').eq('is_deleted', 'n').eq('status', 'active'),
    ]);
    setRows((h || []) as Header[]);
    setWarehouses((w || []) as Warehouse[]);
    setBins((b || []) as Bin[]);
    setProducts((p || []) as Product[]);
    setLoading(false);
  };

  const fetchDetails = async (id: number) => {
    const { data } = await supabase
      .from(detailTable)
      .select('*')
      .eq('is_deleted', 'n')
      .eq('document_id', id)
      .order('line_no');
    setDetails((data || []) as Detail[]);
  };

  /**
   * 打开单据弹窗。传 null 为新建。
   * 明细行必须有 host 表头（明细表 document_id 是 NOT NULL），所以「新增明细」
   * 在没有已保存表头时会被拒 —— 与采购/委外各单据页口径一致。
   */
  const openDocument = async (record: Header | null, viewOnly = false) => {
    setReadOnly(viewOnly);
    setSelected(record);
    if (record) {
      form.setFieldsValue({
        ...record,
        document_date: record.document_date ? dayjs(record.document_date) : undefined,
      });
      await fetchDetails(record.id);
    } else {
      let documentNo: string;
      try {
        documentNo = await nextDocumentNo('other_stock_document');
      } catch (error) {
        message.error(`${t('common.documentNoFailed')}：${(error as Error).message}`);
        return;
      }
      form.resetFields();
      form.setFieldsValue({
        document_no: documentNo,
        document_date: dayjs(),
        direction: 'out',
        business_type: 'gift',
        warehouse_id: undefined,
        location_id: undefined,
        status: 'draft',
      });
      setDetails([]);
    }
    setOpen(true);
  };

  const openAddDetail = () => {
    if (!selected) {
      message.warning(t('otherStock.messages.saveHeaderFirst'));
      return;
    }
    if (isLocked) return;
    setDetailEditing({} as Detail);
    detailForm.setFieldsValue({
      document_id: selected.id,
      line_no: details.length + 1,
      location_id: selected.location_id || undefined,
      product_id: undefined,
      quantity: 1,
      unit_cost: undefined,
      stock_status: 'available',
    });
  };

  const softDeleteHeader = async (record: Header) => {
    const { error } = await supabase.from(tableName).update({ is_deleted: 'y' }).eq('id', record.id);
    if (error) throw error;
    void logOperation({
      operation: 'delete',
      method: 'DELETE',
      params: { table: tableName, recordId: record.id, document_no: record.document_no },
    });
    if (selected?.id === record.id) {
      setOpen(false);
      setSelected(null);
    }
    await fetchAll();
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t('otherStock.statusDraft'), color: 'default' },
    pending: { text: t('otherStock.statusPending'), color: 'warning' },
    approved: { text: t('otherStock.statusApproved'), color: 'blue' },
    posted: { text: t('otherStock.statusPosted'), color: 'success' },
    cancelled: { text: t('otherStock.statusCancelled'), color: 'error' },
  };

  const businessTypeLabel = (type: string) => t(`otherStock.businessTypes.${type}`, { defaultValue: type });
  const directionLabel = (dir: string) =>
    dir === 'out' ? t('otherStock.directions.out') : t('otherStock.directions.in');
  const warehouseLabel = (id: number | null) => warehouses.find((w) => w.id === id)?.name || '-';
  const binLabel = (id: number | null) =>
    id ? bins.find((b) => b.id === id)?.name || '-' : '-';
  const productLabel = (id: number | null) =>
    id ? products.find((p) => p.id === id)?.name || '-' : '-';

  /** 业务类型选项：入库只给「收」的用途，出库只给「发」的用途 —— 选错方向账就反了 */
  const businessTypeOptions = (dir: string | undefined) => {
    const list = dir === 'out' ? OUT_TYPES : IN_TYPES;
    return list.map((value) => ({ value, label: businessTypeLabel(value) }));
  };

  const postDocument = async (id: number) => {
    const { error: approveError } = await supabase
      .from(tableName)
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', id);
    if (approveError) throw approveError;

    const { data, error } = await supabase.rpc('post_other_stock_document', {
      p_document_type: 'other_stock_document',
      p_document_id: id,
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) throw error;
    return data as { voucher?: InventoryVoucherResult; warnings?: string[] } | null;
  };

  const handleBatchPost = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = rows.filter((row) => selectedIds.has(row.id) && row.status !== 'posted');
    if (targets.length === 0) {
      message.warning(t('otherStock.messages.postNoTarget'));
      return;
    }
    Modal.confirm({
      title: t('otherStock.approveAndPost'),
      content: t('otherStock.postConfirmContentMany', { count: targets.length }),
      okText: t('common.continue'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        setPosting(true);
        let success = 0;
        const failures: string[] = [];
        const notices: string[] = [];
        try {
          for (const record of targets) {
            try {
              const result = await postDocument(record.id);
              success += 1;
              const notice = voucherNotice(result, t);
              if (notice) notices.push(`${record.document_no}：${notice}`);
              // 业务判断类提示（如入库状态与「入库即待检」配置不一致）不阻断过账
              if (result?.warnings && result.warnings.length > 0) {
                notices.push(`${record.document_no}：${result.warnings.join('；')}`);
              }
            } catch (error: any) {
              console.error('Error posting other stock document:', error);
              failures.push(`${record.document_no}：${error?.message || t('otherStock.messages.postFailed')}`);
            }
          }
          if (failures.length === 0) {
            message.success(t('otherStock.messages.postSuccessMany', { count: success }));
          } else {
            message.error(
              t('otherStock.messages.postPartialFailed', {
                success,
                failed: failures.length,
                detail: failures.join('；'),
              }),
            );
          }
          if (notices.length > 0) message.warning(notices.join('；'), 10);
          setSelectedRowKeys([]);
          await fetchAll();
        } finally {
          setPosting(false);
        }
      },
    });
  };

  const runReverse = async (targets: Header[]) => {
    setPosting(true);
    let success = 0;
    const failures: string[] = [];
    const notices: string[] = [];
    try {
      for (const record of targets) {
        try {
          const { data, error } = await supabase.rpc('reverse_other_stock_document', {
            p_document_type: 'other_stock_document',
            p_document_id: record.id,
            p_idempotency_key: crypto.randomUUID(),
          });
          if (error) throw error;
          success += 1;
          const notice = voucherNotice(data as { voucher?: InventoryVoucherResult } | null, t);
          if (notice) notices.push(`${record.document_no}：${notice}`);
        } catch (error: any) {
          console.error('Error reversing other stock document:', error);
          failures.push(`${record.document_no}：${error?.message || t('otherStock.messages.reverseFailed')}`);
        }
      }
      if (failures.length === 0) {
        message.success(t('otherStock.messages.reverseSuccessMany', { count: success }));
      } else {
        message.error(
          t('otherStock.messages.reversePartialFailed', {
            success,
            failed: failures.length,
            detail: failures.join('；'),
          }),
        );
      }
      if (notices.length > 0) message.warning(notices.join('；'), 10);
      setSelectedRowKeys([]);
      await fetchAll();
    } finally {
      setPosting(false);
    }
  };

  const confirmReverse = (targets: Header[]) => {
    Modal.confirm({
      title: t('otherStock.reverse'),
      content: t('otherStock.reverseConfirmContentMany', { count: targets.length }),
      okText: t('common.continue'),
      cancelText: t('common.cancel'),
      onOk: () => runReverse(targets),
    });
  };

  const handleBatchReverse = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = rows.filter((row) => selectedIds.has(row.id) && row.status === 'posted');
    if (targets.length === 0) {
      message.warning(t('otherStock.messages.reverseNoTarget'));
      return;
    }
    confirmReverse(targets);
  };

  const columns = [
    { title: t('otherStock.documentNo'), key: 'document_no', dataIndex: 'document_no' },
    { title: t('otherStock.date'), key: 'document_date', dataIndex: 'document_date' },
    {
      title: t('otherStock.direction'),
      key: 'direction',
      dataIndex: 'direction',
      render: (v: string) => (
        <Tag color={v === 'out' ? 'green' : 'red'}>{directionLabel(v)}</Tag>
      ),
    },
    {
      title: t('otherStock.businessType'),
      key: 'business_type',
      dataIndex: 'business_type',
      render: (v: string) => businessTypeLabel(v),
    },
    {
      title: t('otherStock.warehouse'),
      key: 'warehouse_id',
      dataIndex: 'warehouse_id',
      render: (v: number) => warehouseLabel(v),
    },
    { title: t('otherStock.counterparty'), key: 'counterparty', dataIndex: 'counterparty' },
    { title: t('otherStock.reason'), key: 'reason', dataIndex: 'reason' },
    {
      title: t('otherStock.totalCost'),
      key: 'total_cost',
      dataIndex: 'total_cost',
      align: 'right' as const,
      render: (v: number) => formatMoney(v),
    },
    {
      title: t('common.status'),
      key: 'status',
      dataIndex: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: unknown, record: Header) => (
        <Space>
          <Button type="text" onClick={() => void openDocument(record, true)}>
            {t('otherStock.detail')}
          </Button>
          <Button type="text" icon={<EditOutlined />} onClick={() => void openDocument(record)}>
            {t('common.edit')}
          </Button>
          {record.status === 'posted' && (
            <Button type="text" danger icon={<UndoOutlined />} onClick={() => confirmReverse([record])}>
              {t('otherStock.reverse')}
            </Button>
          )}
          <Button
            danger
            type="text"
            icon={<DeleteOutlined />}
            onClick={() => void softDeleteHeader(record)}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    { title: t('otherStock.lineNo'), dataIndex: 'line_no' },
    {
      title: t('otherStock.product'),
      dataIndex: 'product_id',
      render: (v: number) => productLabel(v),
    },
    {
      title: t('otherStock.quantity'),
      dataIndex: 'quantity',
      align: 'right' as const,
      render: (v: number) => formatQuantity(v),
    },
    {
      title: t('otherStock.unitCost'),
      dataIndex: 'unit_cost',
      align: 'right' as const,
      render: (v: number) => formatMoney(v),
    },
    {
      title: t('otherStock.bin'),
      dataIndex: 'location_id',
      render: (v: number | null) => binLabel(v),
    },
    { title: t('otherStock.batchNo'), dataIndex: 'batch_no' },
    {
      title: t('otherStock.stockStatus'),
      dataIndex: 'stock_status',
      render: (v: string) => t(`otherStock.stockStatuses.${v}`, { defaultValue: v }),
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: unknown, record: Detail) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            type="text"
            disabled={isLocked}
            onClick={() => {
              setDetailEditing(record);
              detailForm.setFieldsValue({ ...record, expiry_date: record.expiry_date ? dayjs(record.expiry_date) : undefined });
            }}
          >
            {t('common.edit')}
          </Button>
          <Button
            size="small"
            danger
            type="text"
            icon={<DeleteOutlined />}
            disabled={isLocked}
            onClick={async () => {
              await supabase.from(detailTable).update({ is_deleted: 'y' }).eq('id', record.id);
              void logOperation({
                operation: 'delete',
                method: 'DELETE',
                params: {
                  table: detailTable,
                  recordId: record.id,
                  line_no: record.line_no,
                  document_no: selected?.document_no,
                },
              });
              if (selected) await fetchDetails(selected.id);
            }}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <SuperTable
        columns={columns}
        dataSource={rows}
        loading={loading}
        rowKey="id"
        storageKey="other-stock-documents"
        headerTitle={t('otherStock.title')}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => void openDocument(null)}
            >
              {t('common.create')}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t('otherStock.approveAndPost')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ''}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t('otherStock.reverse')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ''}
            </Button>
          </Space>
        }
      />

      <SupaModal
        title={
          !selected
            ? t('otherStock.add')
            : isLocked
              ? t('otherStock.viewTitle')
              : t('otherStock.editTitle')
        }
        open={open}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
        }}
        headerPanelTitle={t('otherStock.headerPanelTitle')}
        detailPanelTitle={t('otherStock.detailPanelTitle')}
        historyTable={tableName}
        historyRecordId={selected?.id}
        navigation={buildModalNav(rows, selected?.id, openDocument)}
        form={form}
        disabled={isLocked}
        formEle={
        <Form
          form={form}
          layout="vertical"
          disabled={isLocked}
          onFinish={async (values) => {
            const payload = {
              ...values,
              document_date:
                values.document_date?.format?.('YYYY-MM-DD') ?? values.document_date,
            };
            if (selected) {
              const { error } = await supabase
                .from(tableName)
                .update(payload)
                .eq('id', selected.id);
              if (error) throw error;
              void logOperation({
                operation: 'update',
                method: 'PUT',
                params: {
                  table: tableName,
                  recordId: selected.id,
                  document_no: selected.document_no,
                },
              });
            } else {
              const { data, error } = await supabase
                .from(tableName)
                .insert([payload])
                .select('id, document_no')
                .single();
              if (error) throw error;
              void logOperation({
                operation: 'create',
                method: 'POST',
                params: {
                  table: tableName,
                  recordId: (data as { id: number } | null)?.id,
                  document_no: (data as { document_no: string } | null)?.document_no,
                },
              });
            }
            setOpen(false);
            await fetchAll();
          }}
        >
          {/* 两列布局：span=12 成对排一行，span=24 的备注独占一行（与采购/销售/委外各页同构） */}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="document_no" label={t('otherStock.documentNo')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="document_date" label={t('otherStock.date')} rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="direction"
                label={t('otherStock.direction')}
                rules={[{ required: true }]}
                extra={t('otherStock.directionHint')}
              >
                <Select
                  options={[
                    { value: 'in', label: t('otherStock.directions.in') },
                    { value: 'out', label: t('otherStock.directions.out') },
                  ]}
                  onChange={(dir: string) => {
                    // 换方向就把业务类型收敛到该方向合法的取值，避免「入库 + 报废」这种矛盾组合
                    const list: readonly string[] = dir === 'out' ? OUT_TYPES : IN_TYPES;
                    if (!list.includes(form.getFieldValue('business_type'))) {
                      form.setFieldsValue({ business_type: list[0] });
                    }
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="business_type"
                label={t('otherStock.businessType')}
                rules={[{ required: true }]}
                extra={t('otherStock.businessTypeHint')}
              >
                <Select options={businessTypeOptions(form.getFieldValue('direction'))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="warehouse_id" label={t('otherStock.warehouse')} rules={[{ required: true }]}>
                <Select
                  options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
                  onChange={handleWarehouseChange}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_id" label={t('otherStock.bin')}>
                <WarehouseBinSelect warehouseId={headerWarehouseId} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="counterparty" label={t('otherStock.counterparty')}>
                <Input placeholder={t('otherStock.counterpartyPlaceholder')} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="reason" label={t('otherStock.reason')}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="remark" label={t('otherStock.remark')}>
                <Input.TextArea />
              </Form.Item>
            </Col>
          </Row>
        </Form>
        }
        detailExtra={
          // 明细挂在已保存的表头上，所以新建态下按钮可点但会提示「请先保存表头」
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            disabled={isLocked}
            onClick={openAddDetail}
          >
            {t('otherStock.addDetail')}
          </Button>
        }
        tableEle={
          <Table
            rowKey="id"
            size="small"
            dataSource={details}
            columns={detailColumns}
            pagination={false}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" disabled={isLocked} onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width="70%"
        height="80%"
      />

      <SimpleModal
        title={t('otherStock.detailTitle')}
        open={!!detailEditing}
        onCancel={() => setDetailEditing(null)}
        onOk={() => detailForm.submit()}
        destroyOnHidden
        width={760}
      >
        <Form
          form={detailForm}
          layout="vertical"
          onFinish={async (values) => {
            const payload = {
              ...values,
              batch_no: values.batch_no || null,
              expiry_date: values.expiry_date?.format?.('YYYY-MM-DD') ?? values.expiry_date ?? null,
              quantity: values.quantity ?? 0,
              unit_cost: values.unit_cost ?? 0,
            };
            const id = detailEditing?.id;
            if (id) {
              const { error } = await supabase.from(detailTable).update(payload).eq('id', id);
              if (error) throw error;
              void logOperation({
                operation: 'update',
                method: 'PUT',
                params: { table: detailTable, recordId: id, document_no: selected?.document_no },
              });
            } else {
              const { data, error } = await supabase
                .from(detailTable)
                .insert([payload])
                .select('id')
                .single();
              if (error) throw error;
              void logOperation({
                operation: 'create',
                method: 'POST',
                params: {
                  table: detailTable,
                  recordId: (data as { id: number } | null)?.id,
                  document_no: selected?.document_no,
                },
              });
            }
            setDetailEditing(null);
            if (selected) await fetchDetails(selected.id);
          }}
        >
          <Form.Item name="document_id" hidden>
            <Input />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="line_no" label={t('otherStock.lineNo')}>
                <InputNumber style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="product_id" label={t('otherStock.product')} rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="quantity" label={t('otherStock.quantity')} rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} min={0.0001} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="unit_cost"
                label={t('otherStock.unitCost')}
                extra={
                  selected?.direction === 'in'
                    ? t('otherStock.unitCostRequiredIn')
                    : t('otherStock.unitCostOptionalOut')
                }
              >
                <InputNumber style={{ width: '100%' }} min={0} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_id" label={t('otherStock.bin')}>
                <WarehouseBinSelect warehouseId={selected?.warehouse_id} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="batch_no" label={t('otherStock.batchNo')}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="expiry_date" label={t('otherStock.expiryDate')}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="stock_status" label={t('otherStock.stockStatus')}>
                <Select
                  options={STATUS_OPTIONS.map((s) => ({
                    value: s,
                    label: t(`otherStock.stockStatuses.${s}`),
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="remark" label={t('otherStock.remark')}>
                <Input.TextArea />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>
    </>
  );
}

export default OtherStockDocuments;
