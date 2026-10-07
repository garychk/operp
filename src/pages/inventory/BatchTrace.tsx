import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  InputNumber,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useCurrencyRegistry } from '../../utils/money';

/**
 * 批次追溯（P2-12，对应差距文档 E5）。
 *
 * 两个方向的实现方式不同，这是数据决定的（详见 deploy_107 文件头）：
 *   · **上游**（我的料哪来的）：只能靠**单据谱系**推导 ——
 *     「原料批 → 成品批」物料变了，库存流水表达不了，必须走
 *     生产订单（领料批 ↔ 完工入库批）与委外订单（发料批 ↔ 委外入库批）。
 *   · **下游**（这批去哪了）：主要靠**库存流水**（reference_type + reference_id
 *     已指向来源单据），再对「被领用 → 产出新批」的分支做单据谱系递归。
 *
 * 口径提醒（别当成 bug）：
 *   · 只覆盖**有单据链路**的转换。手工在库存调整单里改批次号这种操作不产生谱系；
 *   · 递归深度硬顶 10 层（防数据成环把查询挂死），默认查 5 层；
 *   · 采购入库、期初建账是链路终点（上游为空是正常的，不是查不到）。
 */

type BatchOption = {
  batch_id: number;
  batch_no: string;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;
  expiry_date: string | null;
  on_hand_qty: number;
  batch_status: string;
  qc_status: string;
  expiry_state: string;
  supplier_name: string | null;
  supplier_batch_no: string | null;
  production_date: string | null;
  days_to_expiry: number | null;
  source_type: string;
  source_document_no: string | null;
  created_at: string;
  available_qty: number;
  warehouse_count: number;
  remark: string | null;
};

type ProductOption = {
  id: number;
  code: string;
  name: string;
  is_batch_managed: boolean | null;
};

type UpstreamRow = {
  depth: number;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  batch_no: string | null;
  via: string;
  source_document_no: string | null;
  source_date: string | null;
  quantity: number | null;
  batch_status: string | null;
  qc_status: string | null;
};

type DownstreamRow = {
  depth: number;
  node_type: string;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  batch_no: string | null;
  document_type: string | null;
  document_no: string | null;
  document_date: string | null;
  party_name: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  quantity: number | null;
  unit_cost: number | null;
};

type MovementRow = {
  transaction_id: number;
  transaction_no: string | null;
  transaction_date: string;
  product_id: number;
  product_code: string | null;
  product_name: string | null;
  unit: string | null;
  batch_no: string;
  warehouse_name: string | null;
  bin_name: string | null;
  stock_status: string | null;
  transaction_type_name: string | null;
  direction: string;
  quantity: number;
  unit_cost: number | null;
  total_cost: number | null;
  reference_type: string | null;
  document_no: string | null;
  document_date: string | null;
  party_name: string | null;
};

const batchView = 'vw_erp_batch_stock';
const movementView = 'vw_erp_batch_movement';

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

/** 层级缩进：追溯结果是有向图，用左内边距把层级画出来（比真树组件皮实） */
const DepthCell = ({ depth }: { depth: number }) => (
  <span
    style={{
      display: 'inline-block',
      paddingLeft: depth * 18,
      color: depth === 0 ? undefined : 'rgba(0,0,0,0.45)',
    }}
  >
    {depth === 0 ? '●' : '└'} {depth}
  </span>
);

export function BatchTrace() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatMoney, formatQuantity } = useCurrencyRegistry();
  const tenantId = user?.tenantId ?? null;

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [batchOptions, setBatchOptions] = useState<BatchOption[]>([]);
  const [productId, setProductId] = useState<number | null>(null);
  const [batchNo, setBatchNo] = useState<string | null>(null);
  const [maxDepth, setMaxDepth] = useState(5);

  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<BatchOption | null>(null);
  const [upstream, setUpstream] = useState<UpstreamRow[]>([]);
  const [downstream, setDownstream] = useState<DownstreamRow[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('erp_products_s_539dcf81_b')
        .select('id, code, name, is_batch_managed')
        .eq('is_deleted', 'n')
        .order('code');
      setProducts((data || []) as ProductOption[]);
    })();
  }, []);

  /** 选定物料后拉它的批次（含无现存量但有档案的批次，才能追已出完的批） */
  const loadBatches = useCallback(async (pid: number) => {
    const { data, error } = await supabase
      .from(batchView as never)
      .select('*')
      .eq('product_id', pid)
      .order('batch_no');
    if (error) {
      message.error(error.message);
      return;
    }
    setBatchOptions((data || []) as unknown as BatchOption[]);
  }, []);

  const onProductChange = (pid: number) => {
    setProductId(pid);
    setBatchNo(null);
    setBatchOptions([]);
    setProfile(null);
    setUpstream([]);
    setDownstream([]);
    setMovements([]);
    setSearched(false);
    void loadBatches(pid);
  };

  const runTrace = async () => {
    if (!productId || !batchNo) {
      message.warning(t('batchTrace.messages.pickFirst'));
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const [prof, up, down, mv] = await Promise.all([
        supabase
          .from(batchView as never)
          .select('*')
          .eq('product_id', productId)
          .eq('batch_no', batchNo)
          .maybeSingle(),
        supabase.rpc('trace_batch_upstream' as never, {
          p_tenant_id: tenantId,
          p_product_id: productId,
          p_batch_no: batchNo,
          p_max_depth: maxDepth,
        } as never),
        supabase.rpc('trace_batch_downstream' as never, {
          p_tenant_id: tenantId,
          p_product_id: productId,
          p_batch_no: batchNo,
          p_max_depth: maxDepth,
        } as never),
        supabase
          .from(movementView as never)
          .select('*')
          .eq('product_id', productId)
          .eq('batch_no', batchNo)
          .order('transaction_date', { ascending: false }),
      ]);

      if (prof.error) throw prof.error;
      if (up.error) throw up.error;
      if (down.error) throw down.error;
      if (mv.error) throw mv.error;

      setProfile((prof.data || null) as unknown as BatchOption | null);
      setUpstream((up.data || []) as unknown as UpstreamRow[]);
      setDownstream((down.data || []) as unknown as DownstreamRow[]);
      setMovements((mv.data || []) as unknown as MovementRow[]);
    } catch (error) {
      console.error('trace failed', error);
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const upstreamHasChain = useMemo(() => upstream.some((r) => r.depth > 0), [upstream]);
  const downstreamHasChain = useMemo(() => downstream.some((r) => r.depth > 0), [downstream]);

  const upstreamColumns = [
    {
      title: t('batchTrace.columns.depth'),
      dataIndex: 'depth',
      key: 'depth',
      width: 80,
      render: (d: number) => <DepthCell depth={d} />,
    },
    {
      title: t('batchTrace.columns.via'),
      dataIndex: 'via',
      key: 'via',
      width: 140,
      render: (v: string) => <Tag>{t(`batchTrace.via.${v}`)}</Tag>,
    },
    {
      title: t('batchTrace.columns.product'),
      key: 'product',
      render: (_: unknown, r: UpstreamRow) => (
        <div>
          <div>{r.product_name || '-'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.product_code}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t('batchTrace.columns.batchNo'),
      dataIndex: 'batch_no',
      key: 'batch_no',
      width: 170,
    },
    {
      title: t('batchTrace.columns.documentNo'),
      dataIndex: 'source_document_no',
      key: 'source_document_no',
      width: 170,
      render: (v: string | null, r: UpstreamRow) => (
        <div>
          <div>{v || '-'}</div>
          {r.source_date && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.source_date}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: t('batchTrace.columns.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      width: 120,
      align: 'right' as const,
      render: (v: number | null) => (v === null ? '-' : formatQuantity(Number(v))),
    },
    {
      title: t('batchTrace.columns.batchState'),
      key: 'state',
      width: 150,
      render: (_: unknown, r: UpstreamRow) => (
        <Space size={4}>
          {r.qc_status && <Tag>{t(`batches.qcStatuses.${r.qc_status}`)}</Tag>}
          {r.batch_status && (
            <Tag color={r.batch_status === 'blocked' ? 'default' : 'green'}>
              {t(`batches.batchStatuses.${r.batch_status}`)}
            </Tag>
          )}
          {!r.qc_status && !r.batch_status && <Tag>{t('batchTrace.noProfile')}</Tag>}
        </Space>
      ),
    },
  ];

  const downstreamColumns = [
    {
      title: t('batchTrace.columns.depth'),
      dataIndex: 'depth',
      key: 'depth',
      width: 80,
      render: (d: number) => <DepthCell depth={d} />,
    },
    {
      title: t('batchTrace.columns.nodeType'),
      dataIndex: 'node_type',
      key: 'node_type',
      width: 120,
      render: (v: string) => (
        <Tag color={v === 'issue' ? 'blue' : v === 'product' ? 'purple' : 'default'}>
          {t(`batchTrace.nodeTypes.${v}`)}
        </Tag>
      ),
    },
    {
      title: t('batchTrace.columns.product'),
      key: 'product',
      render: (_: unknown, r: DownstreamRow) => (
        <div>
          <div>{r.product_name || '-'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.product_code}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t('batchTrace.columns.batchNo'),
      dataIndex: 'batch_no',
      key: 'batch_no',
      width: 160,
    },
    {
      title: t('batchTrace.columns.document'),
      key: 'document',
      width: 230,
      render: (_: unknown, r: DownstreamRow) => (
        <div>
          <div>{r.document_no || '-'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.document_type ? t(`batchTrace.docTypes.${r.document_type}`, { defaultValue: r.document_type }) : ''}
            {r.document_date ? ` · ${r.document_date}` : ''}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t('batchTrace.columns.party'),
      dataIndex: 'party_name',
      key: 'party_name',
      width: 160,
      render: (v: string | null) => v || '-',
    },
    {
      title: t('batchTrace.columns.warehouse'),
      dataIndex: 'warehouse_name',
      key: 'warehouse_name',
      width: 130,
      render: (v: string | null) => v || '-',
    },
    {
      title: t('batchTrace.columns.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      width: 110,
      align: 'right' as const,
      render: (v: number | null) => (v === null ? '-' : formatQuantity(Number(v))),
    },
  ];

  const movementColumns = [
    {
      title: t('batchTrace.columns.date'),
      dataIndex: 'transaction_date',
      key: 'transaction_date',
      width: 120,
    },
    {
      title: t('batchTrace.columns.transactionNo'),
      dataIndex: 'transaction_no',
      key: 'transaction_no',
      width: 160,
    },
    {
      title: t('batchTrace.columns.transactionType'),
      dataIndex: 'transaction_type_name',
      key: 'transaction_type_name',
      width: 150,
      render: (v: string | null, r: MovementRow) => (
        <Space size={4}>
          <Tag color={r.direction === 'in' ? 'green' : r.direction === 'out' ? 'red' : 'default'}>
            {r.direction === 'in' ? t('batchTrace.directions.in') : r.direction === 'out' ? t('batchTrace.directions.out') : t('batchTrace.directions.neutral')}
          </Tag>
          {v || '-'}
        </Space>
      ),
    },
    {
      title: t('batchTrace.columns.warehouseBin'),
      key: 'warehouseBin',
      width: 190,
      render: (_: unknown, r: MovementRow) => (
        <div>
          <div>{r.warehouse_name || '-'}</div>
          {r.bin_name && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.bin_name}
            </Typography.Text>
          )}
        </div>
      ),
    },
    {
      title: t('batchTrace.columns.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      width: 120,
      align: 'right' as const,
      render: (v: number) => (
        <span style={{ color: Number(v) < 0 ? '#cf1322' : '#389e0d' }}>{formatQuantity(Number(v))}</span>
      ),
    },
    {
      title: t('batchTrace.columns.amount'),
      dataIndex: 'total_cost',
      key: 'total_cost',
      width: 130,
      align: 'right' as const,
      render: (v: number | null) => (v === null ? '-' : formatMoney(Number(v))),
    },
    {
      title: t('batchTrace.columns.document'),
      key: 'document',
      width: 200,
      render: (_: unknown, r: MovementRow) => (
        <div>
          <div>{r.document_no || '-'}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.reference_type || ''}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: t('batchTrace.columns.party'),
      dataIndex: 'party_name',
      key: 'party_name',
      width: 150,
      render: (v: string | null) => v || '-',
    },
  ];

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Row gutter={12} align="middle">
          <Col span={7}>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder={t('batchTrace.fields.productPlaceholder')}
              value={productId ?? undefined}
              onChange={onProductChange}
              options={products.map((p) => ({
                value: p.id,
                label: `${p.code} ${p.name}${p.is_batch_managed ? ` · ${t('batchTrace.batchManagedTag')}` : ''}`,
              }))}
            />
          </Col>
          <Col span={7}>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder={t('batchTrace.fields.batchPlaceholder')}
              value={batchNo ?? undefined}
              disabled={!productId}
              onChange={setBatchNo}
              options={batchOptions.map((b) => ({
                value: b.batch_no,
                label: `${b.batch_no}${
                  b.expiry_date ? ` · ${t('batchTrace.fields.expiryShort')} ${b.expiry_date}` : ''
                }${Number(b.on_hand_qty) > 0 ? ` · ${formatQuantity(Number(b.on_hand_qty))}${b.unit || ''}` : ''}`,
              }))}
            />
          </Col>
          <Col span={4}>
            <InputNumber
              style={{ width: '100%' }}
              min={1}
              max={10}
              value={maxDepth}
              onChange={(v) => setMaxDepth(Number(v) || 5)}
              addonBefore={t('batchTrace.fields.depth')}
            />
          </Col>
          <Col span={6}>
            <Space>
              <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={runTrace}>
                {t('batchTrace.query')}
              </Button>
              <Button icon={<ReloadOutlined />} onClick={() => void runTrace()} disabled={!searched}>
                {t('common.refresh')}
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {!searched ? (
        <Card>
          <Empty description={t('batchTrace.messages.pickFirst')} />
        </Card>
      ) : (
        <>
          {profile && (
            <Card size="small" style={{ marginBottom: 12 }}>
              <Descriptions
                size="small"
                column={4}
                title={
                  <Space>
                    <span>{`${profile.batch_no}`}</span>
                    <Tag color={expiryStateColor(profile.expiry_state)}>
                      {t(`batches.expiryStates.${profile.expiry_state}`)}
                    </Tag>
                    {profile.batch_status === 'blocked' && (
                      <Tag color="default">{t('batches.batchStatuses.blocked')}</Tag>
                    )}
                  </Space>
                }
              >
                <Descriptions.Item label={t('batchTrace.fields.product')}>
                  {`${profile.product_code || ''} ${profile.product_name || ''}`}
                </Descriptions.Item>
                <Descriptions.Item label={t('batchTrace.fields.onHand')}>
                  {`${formatQuantity(Number(profile.on_hand_qty))} ${profile.unit || ''}`}
                </Descriptions.Item>
                <Descriptions.Item label={t('batchTrace.fields.productionDate')}>
                  {profile.production_date || '-'}
                </Descriptions.Item>
                <Descriptions.Item label={t('batchTrace.fields.expiryDate')}>
                  {profile.expiry_date || '-'}
                  {profile.days_to_expiry !== null
                    ? profile.days_to_expiry < 0
                      ? ` (${t('batches.expiryStates.expiredBy', { days: Math.abs(profile.days_to_expiry) })})`
                      : ` (${t('batches.expiryStates.leftDays', { days: profile.days_to_expiry })})`
                    : ''}
                </Descriptions.Item>
                <Descriptions.Item label={t('batchTrace.fields.supplier')}>
                  {profile.supplier_name || '-'}
                </Descriptions.Item>
                <Descriptions.Item label={t('batchTrace.fields.supplierBatchNo')}>
                  {profile.supplier_batch_no || '-'}
                </Descriptions.Item>
                <Descriptions.Item label={t('batchTrace.fields.qcStatus')}>
                  <Tag>{t(`batches.qcStatuses.${profile.qc_status}`)}</Tag>
                </Descriptions.Item>
                <Descriptions.Item label={t('batchTrace.fields.source')}>
                  {t(`batches.sourceTypes.${profile.source_type}`)}
                  {profile.source_document_no ? ` · ${profile.source_document_no}` : ''}
                </Descriptions.Item>
              </Descriptions>
            </Card>
          )}

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('batchTrace.caliberTitle')}
            description={t('batchTrace.caliberBody')}
          />

          <Tabs
            items={[
              {
                key: 'up',
                label: `${t('batchTrace.tabs.upstream')} (${Math.max(upstream.length - 1, 0)})`,
                children: (
                  <>
                    {!upstreamHasChain && (
                      <Alert
                        type="success"
                        showIcon
                        style={{ marginBottom: 8 }}
                        message={t('batchTrace.messages.noUpstream')}
                      />
                    )}
                    <Table
                      size="small"
                      rowKey={(r) => `${r.depth}-${r.product_id}-${r.batch_no}-${r.via}`}
                      columns={upstreamColumns}
                      dataSource={upstream}
                      pagination={false}
                      scroll={{ x: 1100 }}
                    />
                  </>
                ),
              },
              {
                key: 'down',
                label: `${t('batchTrace.tabs.downstream')} (${Math.max(downstream.length - 1, 0)})`,
                children: (
                  <>
                    {!downstreamHasChain && (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginBottom: 8 }}
                        message={t('batchTrace.messages.noDownstream')}
                      />
                    )}
                    <Table
                      size="small"
                      rowKey={(r) => `${r.depth}-${r.node_type}-${r.product_id}-${r.batch_no}-${r.document_no ?? ''}`}
                      columns={downstreamColumns}
                      dataSource={downstream}
                      pagination={false}
                      scroll={{ x: 1300 }}
                    />
                  </>
                ),
              },
              {
                key: 'movements',
                label: `${t('batchTrace.tabs.movements')} (${movements.length})`,
                children: (
                  <Table
                    size="small"
                    rowKey="transaction_id"
                    columns={movementColumns}
                    dataSource={movements}
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    scroll={{ x: 1400 }}
                  />
                ),
              },
            ]}
          />

          <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
            {t('batchTrace.footnote')}
          </Typography.Paragraph>
        </>
      )}
    </div>
  );
}

export default BatchTrace;
