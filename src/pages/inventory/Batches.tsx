import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ImportOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { SupaModal, buildModalNav } from '../../components/SupaModal';
import SimpleModal from '../../components/SimpleModal';
import { logOperation } from '../../utils/logger';
import { useCurrencyRegistry } from '../../utils/money';
import { useAuth } from '../../contexts/AuthContext';

/**
 * 批次管理（P2-12，对应差距文档 E1 / E2 / E4）。
 *
 * 读的是 `vw_erp_batch_stock`（deploy_107）：批次档案 + 现存汇总 + 效期分桶
 * 都在数据库里算好，前端只做筛选与展示。
 *
 * 三个必须知道的口径（详见 deploy_106/107 文件头，别当成 bug）：
 *  ① 「批次管理」开关在**物料**上（物料管理页勾选），过账强制点在
 *     `inventory_apply_move` 这一个漏斗，不是本页面 —— 这里改不动物料的开关。
 *  ② 效期**只补不猜**：入库时明细没填效期会取本档案上的效期；
 *     但绝不会用「生产日期 + 保质期」去隐式推算（猜错的效期会静默误报预警）。
 *     本页的「按保质期算效期」按钮是**人工显式触发**的辅助功能。
 *  ③ 冻结（blocked）批次**连冲销都会被拦**，这是故意的：冻结通常意味着
 *     质量事故，解冻必须留下一条有记录的动作。
 */

type BatchStockRow = {
  tenant_id: number;
  batch_id: number;
  batch_no: string;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  specification: string | null;
  unit: string | null;
  is_batch_managed: boolean | null;
  supplier_id: number | null;
  supplier_name: string | null;
  supplier_batch_no: string | null;
  production_date: string | null;
  expiry_date: string | null;
  shelf_life_days: number | null;
  qc_status: string;
  batch_status: string;
  source_type: string;
  source_document_no: string | null;
  ref_unit_cost: number;
  remark: string | null;
  created_at: string;
  on_hand_qty: number;
  on_hand_amount: number;
  available_qty: number;
  locked_qty: number;
  warehouse_count: number;
  days_to_expiry: number | null;
  expiry_state: string;
};

type ProductOption = {
  id: number;
  code: string;
  name: string;
  shelf_life_days: number | null;
  is_batch_managed: boolean | null;
};

type SupplierOption = { id: number; code: string; name: string };

const batchTable = 'erp_batches_s_539dcf81_b';
const viewName = 'vw_erp_batch_stock';

const QC_STATUSES = ['pending', 'passed', 'failed', 'hold'] as const;

/** 效期状态的 Tag 颜色：过期红、临期橙/金、冻结灰、正常绿 */
const expiryStateColor = (state: string): string => {
  switch (state) {
    case 'expired':
      return 'red';
    case 'critical':
      return 'volcano';
    case 'warning':
      return 'gold';
    case 'blocked':
      return 'default';
    default:
      return 'green';
  }
};

const qcStatusColor = (s: string): string => {
  switch (s) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'error';
    case 'hold':
      return 'warning';
    default:
      return 'default';
  }
};

export function Batches() {
  const { t } = useTranslation();
  const { formatMoney, formatQuantity } = useCurrencyRegistry();
  // 租户显式传给 RPC：后端虽已能按 current_tenant_id() 兜底解析，
  // 但显式传值可以避免「超管会话 + 无租户」时静默落到错误租户（与 BatchTrace 同款）。
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? null;

  const [rows, setRows] = useState<BatchStockRow[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<BatchStockRow | null>(null);
  const [form] = Form.useForm();

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from(viewName as never)
        .select('*')
        .order('expiry_date', { ascending: true, nullsFirst: false })
        .order('batch_no', { ascending: true });
      if (error) throw error;
      setRows((data || []) as unknown as BatchStockRow[]);
    } catch (error) {
      console.error('Error fetching batches:', error);
      message.error(t('batches.messages.fetchFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchRefs = useCallback(async () => {
    const [p, s] = await Promise.all([
      supabase
        .from('erp_products_s_539dcf81_b')
        .select('id, code, name, shelf_life_days, is_batch_managed')
        .eq('is_deleted', 'n')
        .order('code'),
      supabase
        .from('erp_suppliers_s_539dcf81_b')
        .select('id, code, name')
        .eq('is_deleted', 'n')
        .order('code'),
    ]);
    setProducts((p.data || []) as ProductOption[]);
    setSuppliers((s.data || []) as SupplierOption[]);
  }, []);

  useEffect(() => {
    void fetchAll();
    void fetchRefs();
  }, [fetchAll, fetchRefs]);

  // ---- 统计卡片（只统计还有实体库存的批次，账上已出完的过期批次不需要人处理）----
  const stats = useMemo(() => {
    const alive = rows.filter((r) => Number(r.on_hand_qty) > 0);
    return {
      expired: alive.filter((r) => r.expiry_state === 'expired').length,
      critical: alive.filter((r) => r.expiry_state === 'critical').length,
      warning: alive.filter((r) => r.expiry_state === 'warning').length,
      blocked: rows.filter((r) => r.batch_status === 'blocked').length,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const kw = searchTerm.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== 'all') {
        if (filter === 'blocked') {
          if (r.batch_status !== 'blocked') return false;
        } else if (filter === 'alive') {
          if (Number(r.on_hand_qty) <= 0) return false;
        } else if (r.expiry_state !== filter) {
          return false;
        }
      }
      if (!kw) return true;
      return (
        r.batch_no.toLowerCase().includes(kw) ||
        (r.product_code || '').toLowerCase().includes(kw) ||
        (r.product_name || '').toLowerCase().includes(kw) ||
        (r.supplier_batch_no || '').toLowerCase().includes(kw)
      );
    });
  }, [rows, filter, searchTerm]);

  // ---- 新建 / 编辑 ----------------------------------------------------------

  const handleAdd = () => {
    setEditing(null);
    form.setFieldsValue({
      product_id: undefined,
      batch_no: '',
      production_date: undefined,
      expiry_date: undefined,
      shelf_life_days: undefined,
      supplier_id: undefined,
      supplier_batch_no: '',
      qc_status: 'pending',
      status: 'active',
      remark: '',
    });
    setOpen(true);
  };

  const handleEdit = (record: BatchStockRow) => {
    setEditing(record);
    form.setFieldsValue({
      product_id: record.product_id,
      batch_no: record.batch_no,
      production_date: record.production_date ? dayjs(record.production_date) : undefined,
      expiry_date: record.expiry_date ? dayjs(record.expiry_date) : undefined,
      shelf_life_days: record.shelf_life_days ?? undefined,
      supplier_id: record.supplier_id ?? undefined,
      supplier_batch_no: record.supplier_batch_no ?? '',
      qc_status: record.qc_status,
      status: record.batch_status,
      remark: record.remark ?? '',
    });
    setOpen(true);
  };

  /** 选了物料就把该物料的保质期天数带进来（只是初值，可改） */
  const onProductChange = (productId: number) => {
    if (editing) return; // 编辑时不允许换物料（换物料等于换批次身份）
    const p = products.find((x) => x.id === productId);
    form.setFieldsValue({ shelf_life_days: p?.shelf_life_days ?? undefined });
    recalcExpiry();
  };

  /**
   * 「按保质期算效期」：**人工显式触发**，不做隐式推算。
   * 隐式推算会在生产日期没填/填错时静默造出错误效期，反而让预警失真。
   */
  const recalcExpiry = () => {
    const pd = form.getFieldValue('production_date');
    const sl = form.getFieldValue('shelf_life_days');
    if (pd && sl) {
      form.setFieldsValue({ expiry_date: dayjs(pd).add(Number(sl), 'day') });
    }
  };

  const handleSubmit = async (values: Record<string, unknown>) => {
    const productId = values.product_id as number;
    const batchNo = String(values.batch_no ?? '').trim();
    if (!productId || !batchNo) return;

    const { data, error } = await supabase.rpc('erp_batch_upsert' as never, {
      p_tenant_id: tenantId,
      p_product_id: productId,
      p_batch_no: batchNo,
      p_production_date: values.production_date
        ? dayjs(values.production_date as string).format('YYYY-MM-DD')
        : null,
      p_expiry_date: values.expiry_date
        ? dayjs(values.expiry_date as string).format('YYYY-MM-DD')
        : null,
      p_shelf_life_days: values.shelf_life_days ?? null,
      p_supplier_id: values.supplier_id ?? null,
      p_supplier_batch_no: values.supplier_batch_no || null,
      p_qc_status: values.qc_status ?? null,
      p_status: values.status ?? null,
      p_remark: values.remark || null,
      p_actor_id: null,
      // 编辑态允许覆盖人工维护的属性；新建态若批次已存在则只回显不覆盖
      p_update_existing: !!editing,
    } as never);

    if (error) {
      message.error(error.message);
      throw error;
    }

    const result = (data || {}) as { id?: number; created?: boolean };
    void logOperation({
      operation: editing ? 'update' : 'create',
      method: editing ? 'PUT' : 'POST',
      params: {
        table: batchTable,
        recordId: result.id,
        document_no: batchNo,
      },
    });

    setOpen(false);
    form.resetFields();
    setEditing(null);
    await fetchAll();
    if (!editing && result.created === false) {
      message.info(t('batches.messages.existedNotOverwritten'));
    } else {
      message.success(editing ? t('common.updateSuccess') : t('common.createSuccess'));
    }
  };

  // ---- 冻结 / 解冻 ----------------------------------------------------------

  const setBlocked = async (record: BatchStockRow, blocked: boolean) => {
    const { error } = await supabase
      .from(batchTable)
      .update({ status: blocked ? 'blocked' : 'active' })
      .eq('id', record.batch_id);
    if (error) {
      message.error(error.message);
      return;
    }
    void logOperation({
      operation: 'update',
      method: 'PUT',
      params: { table: batchTable, recordId: record.batch_id, document_no: record.batch_no },
    });
    message.success(blocked ? t('batches.messages.blocked') : t('batches.messages.unblocked'));
    await fetchAll();
  };

  const handleDelete = async (record: BatchStockRow) => {
    const { error } = await supabase
      .from(batchTable)
      .update({ is_deleted: 'y' })
      .eq('id', record.batch_id);
    if (error) {
      message.error(error.message);
      return;
    }
    void logOperation({
      operation: 'delete',
      method: 'DELETE',
      params: { table: batchTable, recordId: record.batch_id, document_no: record.batch_no },
    });
    await fetchAll();
  };

  // ---- 批量导入（粘贴）------------------------------------------------------

  /**
   * 每行格式：物料编码,批次号[,生产日期,效期,供应商批号]
   * 分隔符支持 逗号 / Tab / 两个以上空格。逐行报错、不丢好行。
   */
  const parseImportLine = (line: string): string[] =>
    line
      .split(/\t|,|\s{2,}/)
      .map((x) => x.trim())
      .filter((x) => x !== '');

  const runImport = async () => {
    const lines = importText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (lines.length === 0) {
      message.warning(t('batches.messages.importEmpty'));
      return;
    }

    setImporting(true);
    const errors: string[] = [];
    let ok = 0;
    try {
      for (let i = 0; i < lines.length; i += 1) {
        const cells = parseImportLine(lines[i]);
        const seq = i + 1;
        if (cells.length < 2) {
          errors.push(t('batches.messages.importTooFew', { line: seq }));
          continue;
        }
        const [code, batchNo, productionDate, expiryDate, supplierBatchNo] = cells;
        const product = products.find((p) => p.code.toLowerCase() === code.toLowerCase());
        if (!product) {
          errors.push(t('batches.messages.importProductNotFound', { line: seq, code }));
          continue;
        }
        const { error } = await supabase.rpc('erp_batch_upsert' as never, {
          p_tenant_id: tenantId,
          p_product_id: product.id,
          p_batch_no: batchNo,
          p_production_date: productionDate || null,
          p_expiry_date: expiryDate || null,
          p_shelf_life_days: product.shelf_life_days ?? null,
          p_supplier_id: null,
          p_supplier_batch_no: supplierBatchNo || null,
          p_qc_status: null,
          p_status: null,
          p_remark: null,
          p_actor_id: null,
          p_update_existing: false,
        } as never);
        if (error) {
          errors.push(t('batches.messages.importFailed', { line: seq, msg: error.message }));
        } else {
          ok += 1;
        }
      }

      if (ok > 0) {
        void logOperation({
          operation: 'create',
          method: 'POST',
          params: { table: batchTable, count: ok },
        });
      }
      if (errors.length > 0) {
        message.warning(
          t('batches.messages.importPartial', { ok, failed: errors.length, detail: errors.slice(0, 3).join(' / ') }),
        );
      } else {
        message.success(t('batches.messages.importDone', { ok }));
      }
      if (errors.length === 0) {
        setImportOpen(false);
        setImportText('');
        await fetchAll();
      } else {
        await fetchAll();
      }
    } finally {
      setImporting(false);
    }
  };

  // ---- 列 -------------------------------------------------------------------

  const columns = [
    {
      title: t('batches.columns.batchNo'),
      dataIndex: 'batch_no',
      key: 'batch_no',
      width: 170,
      render: (v: string, r: BatchStockRow) => (
        <Space size={4}>
          <Typography.Text strong>{v}</Typography.Text>
          {r.batch_status === 'blocked' && <Tag color="default">{t('batches.batchStatuses.blocked')}</Tag>}
        </Space>
      ),
    },
    {
      title: t('batches.columns.product'),
      key: 'product',
      width: 240,
      render: (_: unknown, r: BatchStockRow) => (
        <div>
          <div>{r.product_name || '-'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.product_code}
            {r.specification ? ` · ${r.specification}` : ''}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t('batches.columns.onHand'),
      key: 'on_hand',
      width: 200,
      align: 'right' as const,
      render: (_: unknown, r: BatchStockRow) => (
        <div>
          <div>
            {formatQuantity(Number(r.on_hand_qty))} {r.unit || ''}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatMoney(Number(r.on_hand_amount))} · {t('batches.columns.availableShort')}{' '}
            {formatQuantity(Number(r.available_qty))} · {r.warehouse_count}
            {t('batches.columns.warehousesShort')}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t('batches.columns.expiry'),
      key: 'expiry',
      width: 190,
      render: (_: unknown, r: BatchStockRow) => (
        <div>
          <div>{r.expiry_date || '-'}</div>
          <Tag color={expiryStateColor(r.expiry_state)} style={{ marginTop: 4 }}>
            {r.days_to_expiry === null
              ? t('batches.expiryStates.none')
              : r.days_to_expiry < 0
                ? t('batches.expiryStates.expiredBy', { days: Math.abs(r.days_to_expiry) })
                : t('batches.expiryStates.leftDays', { days: r.days_to_expiry })}
          </Tag>
        </div>
      ),
    },
    {
      title: t('batches.columns.qcStatus'),
      dataIndex: 'qc_status',
      key: 'qc_status',
      width: 110,
      render: (v: string) => <Tag color={qcStatusColor(v)}>{t(`batches.qcStatuses.${v}`)}</Tag>,
    },
    {
      title: t('batches.columns.supplier'),
      key: 'supplier',
      width: 190,
      render: (_: unknown, r: BatchStockRow) => (
        <div>
          <div>{r.supplier_name || '-'}</div>
          {r.supplier_batch_no && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('batches.columns.supplierBatchNoShort')} {r.supplier_batch_no}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: t('batches.columns.source'),
      dataIndex: 'source_type',
      key: 'source_type',
      width: 130,
      render: (v: string, r: BatchStockRow) => (
        <div>
          <Tag>{t(`batches.sourceTypes.${v}`)}</Tag>
          {r.source_document_no && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.source_document_no}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: t('common.actions'),
      key: 'action',
      width: 210,
      fixed: 'right' as const,
      render: (_: unknown, r: BatchStockRow) => (
        <Space size={2}>
          <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)}>
            {t('common.edit')}
          </Button>
          {r.batch_status === 'blocked' ? (
            <Button
              type="text"
              size="small"
              icon={<UnlockOutlined />}
              onClick={() => setBlocked(r, false)}
            >
              {t('batches.actions.unblock')}
            </Button>
          ) : (
            <Button
              type="text"
              size="small"
              danger
              icon={<LockOutlined />}
              onClick={() => setBlocked(r, true)}
            >
              {t('batches.actions.block')}
            </Button>
          )}
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(r)}
          >
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('batches.stats.expired')}
              value={stats.expired}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('batches.stats.critical')}
              value={stats.critical}
              valueStyle={{ color: '#d4380d' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title={t('batches.stats.warning')}
              value={stats.warning}
              valueStyle={{ color: '#d48806' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title={t('batches.stats.blocked')} value={stats.blocked} />
          </Card>
        </Col>
      </Row>

      <SuperTable
        columns={columns}
        dataSource={filtered}
        loading={loading}
        rowKey="batch_id"
        storageKey="batches"
        headerTitle={t('batches.title')}
        rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              {t('batches.add')}
            </Button>
            <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
              {t('batches.import.button')}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void fetchAll()}>
              {t('common.refresh')}
            </Button>
            <Select
              value={filter}
              style={{ width: 180 }}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('batches.filters.all') },
                { value: 'alive', label: t('batches.filters.alive') },
                { value: 'expired', label: t('batches.filters.expired') },
                { value: 'critical', label: t('batches.filters.critical') },
                { value: 'warning', label: t('batches.filters.warning') },
                { value: 'blocked', label: t('batches.filters.blocked') },
              ]}
            />
            <Input.Search
              allowClear
              style={{ width: 260 }}
              placeholder={t('batches.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </Space>
        }
      />

      {/* 主弹窗：SupaModal 拿操作日志 Timeline；批次是主数据、无明细、无工作流，
          所以不传 workflowDocumentType（传了但库里没流程会渲染黄色警告条） */}
      <SupaModal
        title={editing ? t('batches.editTitle') : t('batches.add')}
        open={open}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
          setEditing(null);
        }}
        headerPanelTitle={editing ? t('batches.editTitle') : t('batches.add')}
        historyTable={batchTable}
        historyRecordId={editing?.batch_id}
        navigation={buildModalNav(filtered, editing?.batch_id, handleEdit, (row) => row.batch_id)}
        form={form}
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            {!editing && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={t('batches.introTitle')}
                description={t('batches.introBody')}
              />
            )}
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('batches.fields.product')}
                  name="product_id"
                  rules={[{ required: true }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    disabled={!!editing}
                    onChange={onProductChange}
                    options={products.map((p) => ({
                      value: p.id,
                      label: `${p.code} ${p.name}${p.is_batch_managed ? '' : ` · ${t('batches.hints.productNotBatchManaged')}`}`,
                    }))}
                    placeholder={t('batches.fields.productPlaceholder')}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t('batches.fields.batchNo')}
                  name="batch_no"
                  rules={[{ required: true }]}
                  extra={t('batches.hints.batchNo')}
                >
                  <Input disabled={!!editing} placeholder={t('batches.fields.batchNoPlaceholder')} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t('batches.fields.productionDate')} name="production_date">
                  <DatePicker style={{ width: '100%' }} onChange={() => recalcExpiry()} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t('batches.fields.shelfLifeDays')}
                  name="shelf_life_days"
                  extra={t('batches.hints.shelfLife')}
                >
                  <InputNumber
                    style={{ width: '100%' }}
                    min={1}
                    onChange={() => recalcExpiry()}
                    placeholder={t('batches.fields.shelfLifePlaceholder')}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t('batches.fields.expiryDate')}
                  name="expiry_date"
                  extra={t('batches.hints.expiry')}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t('batches.fields.qcStatus')} name="qc_status" initialValue="pending">
                  <Select
                    options={QC_STATUSES.map((s) => ({
                      value: s,
                      label: t(`batches.qcStatuses.${s}`),
                    }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t('batches.fields.supplier')} name="supplier_id">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={suppliers.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))}
                    placeholder={t('batches.fields.supplierPlaceholder')}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t('batches.fields.supplierBatchNo')} name="supplier_batch_no">
                  <Input placeholder={t('batches.fields.supplierBatchNoPlaceholder')} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t('batches.fields.status')} name="status" initialValue="active">
                  <Select
                    options={([
                      'active',
                      'blocked',
                      'closed',
                    ] as const).map((s) => ({
                      value: s,
                      label: t(`batches.batchStatuses.${s}`),
                    }))}
                  />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item label={t('batches.fields.remark')} name="remark">
                  <Input.TextArea rows={2} />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
        width="72%"
        height={560}
      />

      <SimpleModal
        title={t('batches.import.title')}
        open={importOpen}
        confirmLoading={importing}
        onCancel={() => setImportOpen(false)}
        onOk={runImport}
        okText={t('batches.import.confirm')}
        width={640}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('batches.import.formatTitle')}
          description={
            <div>
              <div>{t('batches.import.formatBody')}</div>
              <Typography.Text code>P001,LOT-20260101,2026-01-01,2027-01-01,SUP-8899</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <Typography.Text code>P002,LOT-20260102,2026-01-05</Typography.Text>
              </div>
              <div style={{ marginTop: 8 }}>{t('batches.import.formatNote')}</div>
            </div>
          }
        />
        <Input.TextArea
          rows={10}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={t('batches.import.placeholder')}
        />
      </SimpleModal>
    </div>
  );
}

export default Batches;
