import { useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import {
  Alert,
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Typography,
  message,
  DatePicker,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  ImportOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import { voucherNotice, type InventoryVoucherResult } from '../../utils/inventoryVoucher';
import { useCurrencyRegistry } from '../../utils/money';
import { SuperTable } from '../../components/SuperTable';
import SimpleModal from '../../components/SimpleModal';
import { SupaModal } from '../../components/SupaModal';
import { logOperation } from '../../utils/logger';

// ============================================================================
// 期初库存录入 / 导入（deploy_104 / deploy_105）
//
// 三条与普通单据不同的硬约束（都由 RPC 强制，这里同步提示）：
//   ① **单价必填且 > 0**。0 成本期初会把该物料此后所有出库的移动加权单价
//      一起拉低，而且全程不报错 —— 所以宁可拦住不给过账。
//   ② **同一仓库只能有一份已过账期初**。要改就先反过账（反过账会把状态退回
//      已审核，唯一约束随之释放），改完再重过。
//   ③ **默认不进总账**。期初是「余额」不是「本期发生额」：它应该体现在
//      存货科目的期初余额里，而不是生成一张本期凭证（生成了反而把期初
//      算成了本期收入）。收发存汇总表会把期初录入计入「期初」列而不是
//      「本期收入」列 —— 这正是本期 A6 要解决的事。
//      如确需同步进总账，到「存货科目映射」把 opening_balance_in 那行的
//      generate_voucher 打开并指定对方科目即可，不必改代码。
// ============================================================================

type Warehouse = { id: number; code: string; name: string };
type Bin = { id: number; code: string; name: string; warehouse_id: number | null };
type Product = { id: number; code: string; name: string; unit: string | null };
type Header = {
  id: number;
  document_no: string;
  document_date: string;
  warehouse_id: number;
  location_id: number | null;
  total_quantity: number | null;
  total_cost: number | null;
  remark: string | null;
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
  remark: string | null;
};

const tableName = 'erp_opening_balances_s_539dcf81_b';
const detailTable = 'erp_opening_balance_details_s_539dcf81_b';

/** 解析一行粘贴内容：物料编码, 数量, 单价 [, 批次]。逗号 / 制表符 / 多空格都认（Excel 粘贴是制表符）。 */
function parseImportLine(line: string): { code: string; qty: number; cost: number; batch: string | null } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const cells = trimmed.split(/[,\t]+|\s{2,}/).map((s) => s.trim());
  if (cells.length < 3) {
    throw new Error('IMPORT_NEED_3');
  }
  const qty = Number(cells[1]);
  const cost = Number(cells[2]);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('IMPORT_BAD_QTY');
  if (!Number.isFinite(cost) || cost <= 0) throw new Error('IMPORT_BAD_COST');
  return { code: cells[0], qty, cost, batch: cells[3] ? cells[3] : null };
}

export function OpeningBalances() {
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
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form] = Form.useForm();
  const [detailForm] = Form.useForm();
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [posting, setPosting] = useState(false);

  const isLocked = readOnly || selected?.status === 'posted';

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

  const warehouseLabel = (id: number | null) => warehouses.find((w) => w.id === id)?.name || '-';
  const productLabel = (id: number | null) => products.find((p) => p.id === id)?.name || '-';

  /**
   * 打开单据弹窗。传 null 为新建。
   * 明细表 document_id 是 NOT NULL，所以「新增明细/批量导入」要求表头已保存。
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
        documentNo = await nextDocumentNo('opening_balance');
      } catch (error) {
        message.error(`${t('common.documentNoFailed')}：${(error as Error).message}`);
        return;
      }
      form.resetFields();
      form.setFieldsValue({
        document_no: documentNo,
        document_date: dayjs(),
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
      message.warning(t('openingBalances.messages.saveHeaderFirst'));
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

  const detailTotal = useMemo(
    () =>
      details.reduce(
        (acc, d) => {
          acc.qty += Number(d.quantity || 0);
          acc.cost += Number(d.quantity || 0) * Number(d.unit_cost || 0);
          return acc;
        },
        { qty: 0, cost: 0 },
      ),
    [details],
  );

  const postDocument = async (id: number) => {
    const { error: approveError } = await supabase
      .from(tableName)
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', id);
    if (approveError) throw approveError;

    const { data, error } = await supabase.rpc('post_opening_balance_document', {
      p_document_type: 'opening_balance',
      p_document_id: id,
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) throw error;
    return data as { voucher?: InventoryVoucherResult; warnings?: string[]; voucher_note?: string } | null;
  };

  const handleBatchPost = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = rows.filter((row) => selectedIds.has(row.id) && row.status !== 'posted');
    if (targets.length === 0) {
      message.warning(t('openingBalances.messages.postNoTarget'));
      return;
    }
    Modal.confirm({
      title: t('openingBalances.approveAndPost'),
      content: t('openingBalances.postConfirmContentMany', { count: targets.length }),
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
              if (result?.warnings && result.warnings.length > 0) {
                notices.push(`${record.document_no}：${result.warnings.join('；')}`);
              }
            } catch (error: any) {
              console.error('Error posting opening balance:', error);
              failures.push(`${record.document_no}：${error?.message || t('openingBalances.messages.postFailed')}`);
            }
          }
          if (failures.length === 0) {
            message.success(t('openingBalances.messages.postSuccessMany', { count: success }));
          } else {
            message.error(
              t('openingBalances.messages.postPartialFailed', {
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
    try {
      for (const record of targets) {
        try {
          const { error } = await supabase.rpc('reverse_opening_balance_document', {
            p_document_type: 'opening_balance',
            p_document_id: record.id,
            p_idempotency_key: crypto.randomUUID(),
          });
          if (error) throw error;
          success += 1;
        } catch (error: any) {
          console.error('Error reversing opening balance:', error);
          failures.push(`${record.document_no}：${error?.message || t('openingBalances.messages.reverseFailed')}`);
        }
      }
      if (failures.length === 0) {
        message.success(t('openingBalances.messages.reverseSuccessMany', { count: success }));
      } else {
        message.error(
          t('openingBalances.messages.reversePartialFailed', {
            success,
            failed: failures.length,
            detail: failures.join('；'),
          }),
        );
      }
      setSelectedRowKeys([]);
      await fetchAll();
    } finally {
      setPosting(false);
    }
  };

  const confirmReverse = (targets: Header[]) => {
    Modal.confirm({
      title: t('openingBalances.reverse'),
      content: t('openingBalances.reverseConfirmContentMany', { count: targets.length }),
      okText: t('common.continue'),
      cancelText: t('common.cancel'),
      onOk: () => runReverse(targets),
    });
  };

  const handleBatchReverse = () => {
    const selectedIds = new Set(selectedRowKeys.map((key) => Number(key)));
    const targets = rows.filter((row) => selectedIds.has(row.id) && row.status === 'posted');
    if (targets.length === 0) {
      message.warning(t('openingBalances.messages.reverseNoTarget'));
      return;
    }
    confirmReverse(targets);
  };

  /** 批量导入：按物料编码解析粘贴内容，逐行校验后再落库（错误逐行报出，不静默丢弃） */
  const runImport = async () => {
    if (!selected) return;
    setImporting(true);
    try {
      const byCode = new Map(products.map((p) => [p.code.trim().toLowerCase(), p]));
      const lines = importText.split(/\r?\n/);
      const payload: Array<Record<string, unknown>> = [];
      const errors: string[] = [];
      let lineNo = details.length;
      lines.forEach((raw, idx) => {
        if (!raw.trim()) return;
        try {
          const parsed = parseImportLine(raw);
          if (!parsed) return;
          const product = byCode.get(parsed.code.trim().toLowerCase());
          if (!product) {
            errors.push(t('openingBalances.import.unknownCode', { line: idx + 1, code: parsed.code }));
            return;
          }
          lineNo += 1;
          payload.push({
            document_id: selected.id,
            line_no: lineNo,
            product_id: product.id,
            quantity: parsed.qty,
            unit_cost: parsed.cost,
            batch_no: parsed.batch,
            location_id: selected.location_id || null,
            stock_status: 'available',
          });
        } catch (err) {
          const code = (err as Error).message;
          errors.push(
            code === 'IMPORT_BAD_COST'
              ? t('openingBalances.import.badCost', { line: idx + 1 })
              : code === 'IMPORT_BAD_QTY'
                ? t('openingBalances.import.badQty', { line: idx + 1 })
                : t('openingBalances.import.needColumns', { line: idx + 1 }),
          );
        }
      });

      if (payload.length === 0) {
        message.error(t('openingBalances.import.nothingImported', { detail: errors.join('；') }));
        return;
      }
      const { error } = await supabase.from(detailTable).insert(payload);
      if (error) throw error;
      void logOperation({
        operation: 'import',
        method: 'POST',
        params: {
          table: detailTable,
          recordId: selected.id,
          document_no: selected.document_no,
          count: payload.length,
        },
      });

      setImportOpen(false);
      setImportText('');
      await fetchDetails(selected.id);
      if (errors.length > 0) {
        message.warning(
          t('openingBalances.import.partial', {
            count: payload.length,
            failed: errors.length,
            detail: errors.join('；'),
          }),
          10,
        );
      } else {
        message.success(t('openingBalances.import.success', { count: payload.length }));
      }
    } catch (error: any) {
      console.error('Error importing opening balance details:', error);
      message.error(`${t('openingBalances.import.failed')}：${error?.message || ''}`);
    } finally {
      setImporting(false);
    }
  };

  const columns = [
    { title: t('openingBalances.documentNo'), key: 'document_no', dataIndex: 'document_no' },
    { title: t('openingBalances.date'), key: 'document_date', dataIndex: 'document_date' },
    {
      title: t('openingBalances.warehouse'),
      key: 'warehouse_id',
      dataIndex: 'warehouse_id',
      render: (v: number) => warehouseLabel(v),
    },
    {
      title: t('openingBalances.totalQuantity'),
      key: 'total_quantity',
      dataIndex: 'total_quantity',
      align: 'right' as const,
      render: (v: number) => formatQuantity(v),
    },
    {
      title: t('openingBalances.totalCost'),
      key: 'total_cost',
      dataIndex: 'total_cost',
      align: 'right' as const,
      render: (v: number) => formatMoney(v),
    },
    { title: t('openingBalances.remark'), key: 'remark', dataIndex: 'remark' },
    { title: t('common.status'), key: 'status', dataIndex: 'status' },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: unknown, record: Header) => (
        <Space>
          <Button onClick={() => void openDocument(record, true)}>
            {t('openingBalances.detail')}
          </Button>
          <Button onClick={() => void openDocument(record)}>
            {t('common.edit')}
          </Button>
          {record.status === 'posted' && (
            <Button danger icon={<UndoOutlined />} onClick={() => confirmReverse([record])}>
              {t('openingBalances.reverse')}
            </Button>
          )}
          <Button
            danger
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
    { title: t('openingBalances.lineNo'), dataIndex: 'line_no' },
    {
      title: t('openingBalances.product'),
      dataIndex: 'product_id',
      render: (v: number) => productLabel(v),
    },
    {
      title: t('openingBalances.quantity'),
      dataIndex: 'quantity',
      align: 'right' as const,
      render: (v: number) => formatQuantity(v),
    },
    {
      title: t('openingBalances.unitCost'),
      dataIndex: 'unit_cost',
      align: 'right' as const,
      render: (v: number) => formatMoney(v),
    },
    {
      title: t('openingBalances.amount'),
      key: 'amount',
      align: 'right' as const,
      render: (_: unknown, r: Detail) => formatMoney(Number(r.quantity || 0) * Number(r.unit_cost || 0)),
    },
    { title: t('openingBalances.batchNo'), dataIndex: 'batch_no' },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: unknown, record: Detail) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={isLocked}
            onClick={() => {
              setDetailEditing(record);
              detailForm.setFieldsValue({
                ...record,
                expiry_date: record.expiry_date ? dayjs(record.expiry_date) : undefined,
              });
            }}
          >
            {t('common.edit')}
          </Button>
          <Button
            size="small"
            danger
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
        storageKey="opening-balances"
        headerTitle={t('openingBalances.title')}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => void openDocument(null)}
            >
              {t('openingBalances.add')}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchPost}
            >
              {t('openingBalances.approveAndPost')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ''}
            </Button>
            <Button
              danger
              icon={<UndoOutlined />}
              loading={posting}
              disabled={selectedRowKeys.length === 0}
              onClick={handleBatchReverse}
            >
              {t('openingBalances.reverse')}
              {selectedRowKeys.length > 0 ? ` (${selectedRowKeys.length})` : ''}
            </Button>
          </Space>
        }
      />

      <SupaModal
        title={
          !selected
            ? t('openingBalances.add')
            : isLocked
              ? t('openingBalances.viewTitle')
              : t('openingBalances.editTitle')
        }
        open={open}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
        }}
        headerPanelTitle={t('openingBalances.headerPanelTitle')}
        detailPanelTitle={t('openingBalances.detailPanelTitle')}
        historyTable={tableName}
        historyRecordId={selected?.id}
        form={form}
        disabled={isLocked}
        formEle={
        <>
        <Alert
          type="info"
          showIcon
          closable={true}
          style={{ marginBottom: 12 }}
          title={t('openingBalances.introTitle')}
          description={t('openingBalances.introBody')}
        />
        <Form
          form={form}
          layout="vertical"
          disabled={isLocked}
          style={{ padding: "0 16px 0 0" }}
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
              <Form.Item name="document_no" label={t('openingBalances.documentNo')} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="document_date" label={t('openingBalances.date')} rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="warehouse_id" label={t('openingBalances.warehouse')} rules={[{ required: true }]}>
                <Select
                  options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
                  onChange={() => form.setFieldsValue({ location_id: undefined })}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_id" label={t('openingBalances.bin')}>
                <Select
                  allowClear
                  options={bins
                    .filter((b) => b.warehouse_id === form.getFieldValue('warehouse_id'))
                    .map((b) => ({ value: b.id, label: `${b.code} ${b.name}` }))}
                />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="remark" label={t('openingBalances.remark')}>
                <Input.TextArea />
              </Form.Item>
            </Col>
          </Row>
        </Form>
        </>
        }
        detailExtra={
          // 导入与新增明细都挂在已保存的表头上，新建态下会提示「请先保存表头」
          <Space size={4}>
            <Button
              type="link"
              size="small"
              icon={<ImportOutlined />}
              disabled={isLocked}
              onClick={() => {
                if (!selected) {
                  message.warning(t('openingBalances.messages.saveHeaderFirst'));
                  return;
                }
                setImportOpen(true);
              }}
            >
              {t('openingBalances.import.button')}
            </Button>
            <Button
              type="link"
              size="small"
              icon={<PlusOutlined />}
              disabled={isLocked}
              onClick={openAddDetail}
            >
              {t('openingBalances.addDetail')}
            </Button>
          </Space>
        }
        tableEle={
          <>
            <Alert
              type={selected?.status === 'posted' ? 'warning' : 'info'}
              showIcon
              style={{ marginBottom: 8 }}
              message={
                selected?.status === 'posted'
                  ? t('openingBalances.postedHint')
                  : t('openingBalances.costHint')
              }
            />
            <Table
              rowKey="id"
              size="small"
              dataSource={details}
              columns={detailColumns}
              pagination={false}
            />
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <Typography.Text type="secondary">
                {t('openingBalances.detailSummary', {
                  lines: details.length,
                  qty: formatQuantity(detailTotal.qty),
                  amount: formatMoney(detailTotal.cost),
                })}
              </Typography.Text>
            </div>
          </>
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
        title={t('openingBalances.detailTitle')}
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
              <Form.Item name="line_no" label={t('openingBalances.lineNo')}>
                <InputNumber style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="product_id" label={t('openingBalances.product')} rules={[{ required: true }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={products.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="quantity" label={t('openingBalances.quantity')} rules={[{ required: true }]}>
                <InputNumber style={{ width: '100%' }} min={0.0001} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="unit_cost"
                label={t('openingBalances.unitCost')}
                rules={[{ required: true }]}
                extra={t('openingBalances.costHint')}
              >
                <InputNumber style={{ width: '100%' }} min={0.0001} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location_id" label={t('openingBalances.bin')}>
                <Select
                  allowClear
                  options={bins
                    .filter((b) => b.warehouse_id === selected?.warehouse_id)
                    .map((b) => ({ value: b.id, label: `${b.code} ${b.name}` }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="batch_no" label={t('openingBalances.batchNo')}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="expiry_date" label={t('openingBalances.expiryDate')}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="remark" label={t('openingBalances.remark')}>
                <Input.TextArea />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>

      <SimpleModal
        title={t('openingBalances.import.title')}
        open={importOpen}
        confirmLoading={importing}
        onCancel={() => setImportOpen(false)}
        onOk={runImport}
        okText={t('openingBalances.import.confirm')}
        width={640}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('openingBalances.import.format')}
          description={
            <Typography.Text>
              <Typography.Text code>物料编码,数量,单价[,批次]</Typography.Text>
              <br />
              {t('openingBalances.import.example')}
            </Typography.Text>
          }
        />
        <Input.TextArea
          rows={10}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={'P-2026-0001,100,12.5\nP-2026-0002\t50\t8.4\tB202601'}
        />
        <Typography.Text type="secondary">{t('openingBalances.import.unknownHandling')}</Typography.Text>
      </SimpleModal>
    </>
  );
}

export default OpeningBalances;
