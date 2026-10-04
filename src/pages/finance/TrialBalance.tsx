import { useEffect, useMemo, useState } from 'react';
import { Select, Space, Tag, message, Segmented, Tooltip } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { useCurrencyRegistry } from '../../utils/money';


type Period = Tables['erp_accounting_periods_s_539dcf81_b']['Row'];

/** 本位币口径（deploy_75）：借贷都是本位币金额，差额必须为 0 */
type TrialRow = {
  period_id: number | null;
  total_debit: number | null;
  total_credit: number | null;
  balance_diff: number | null;
};

/** 币种口径（deploy_77）：只含外币行的原币发生额，差额**天然不平**，仅作参考 */
type TrialFcRow = {
  period_id: number | null;
  currency: string | null;
  total_fc_debit: number | null;
  total_fc_credit: number | null;
  fc_diff: number | null;
  line_count: number | null;
};

type Scope = 'base' | 'fc';

export function TrialBalance() {
  const { t } = useTranslation();
  const { formatMoney, baseCurrency } = useCurrencyRegistry();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [rows, setRows] = useState<TrialRow[]>([]);
  const [fcRows, setFcRows] = useState<TrialFcRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [periodId, setPeriodId] = useState<number | undefined>();
  const [scope, setScope] = useState<Scope>('base');

  const fetchPeriods = async () => {
    const { data, error } = await supabase
      .from('erp_accounting_periods_s_539dcf81_b')
      .select('*')
      .eq('is_deleted', 'n')
      .order('year', { ascending: false })
      .order('month', { ascending: false });
    if (error) throw error;
    setPeriods((data as Period[]) || []);
  };

  const fetchRows = async (nextPeriodId?: number) => {
    setLoading(true);
    try {
      if (scope === 'fc') {
        // vw_erp_trial_balance_fc：按 (期间, 币种) 汇总原币借贷发生额
        let query = supabase.from('vw_erp_trial_balance_fc' as any).select('*');
        if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
        const { data, error } = await query;
        if (error) throw error;
        setFcRows((data as TrialFcRow[]) || []);
      } else {
        let query = supabase.from('vw_erp_trial_balance' as any).select('*');
        if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
        const { data, error } = await query;
        if (error) throw error;
        setRows((data as TrialRow[]) || []);
      }
    } catch (error) {
      console.error(error);
      message.error(t('trialBalance.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPeriods().catch((error) => {
      console.error(error);
      message.error(t('trialBalance.periodsFailed'));
    });
  }, []);

  // 切换口径要重新取数：两张视图的列与粒度都不一样，不能只换渲染。
  // 首屏也走这里（scope 初值 = base），避免与 mount 各拉一次。
  useEffect(() => {
    fetchRows();
  }, [scope]);

  const periodMap = useMemo(() => new Map(periods.map((item) => [item.id, item])), [periods]);

  const periodLabel = (value: number | null) => {
    const period = value === null ? undefined : periodMap.get(value);
    return period?.year && period?.month
      ? `${period.year}-${String(period.month).padStart(2, '0')}`
      : value || '-';
  };

  const baseColumns = [
    { title: t('trialBalance.period'), dataIndex: 'period_id', key: 'period_id', render: periodLabel },
    { title: t('currency.field.baseDebit'), dataIndex: 'total_debit', key: 'total_debit', render: (value: number) => formatMoney(value, baseCurrency) },
    { title: t('currency.field.baseCredit'), dataIndex: 'total_credit', key: 'total_credit', render: (value: number) => formatMoney(value, baseCurrency) },
    { title: t('trialBalance.difference'), dataIndex: 'balance_diff', key: 'balance_diff', render: (value: number) => <Tag color={Math.abs(value ?? 0) < 0.005 ? 'success' : 'error'}>{formatMoney(value, baseCurrency)}</Tag> },
  ];

  const fcColumns = [
    { title: t('trialBalance.period'), dataIndex: 'period_id', key: 'period_id', render: periodLabel },
    {
      title: t('currency.field.currency'),
      dataIndex: 'currency',
      key: 'currency',
      render: (code: string) => code ? <Tag color="blue">{code}</Tag> : t('currency.baseTag'),
    },
    { title: t('currency.field.fcDebit'), dataIndex: 'total_fc_debit', key: 'total_fc_debit', render: (value: number, record: TrialFcRow) => formatMoney(value, record.currency) },
    { title: t('currency.field.fcCredit'), dataIndex: 'total_fc_credit', key: 'total_fc_credit', render: (value: number, record: TrialFcRow) => formatMoney(value, record.currency) },
    {
      // 外币行不含汇兑损益行（那是本位币行），所以这里不平是**正常的**，
      // 不能照搬本位币口径的红绿判定，否则会天天误报
      title: (
        <Space size={4}>
          {t('currency.fcDiff')}
          <Tooltip title={t('trialBalance.fcDiffTooltip')}>
            <InfoCircleOutlined style={{ color: '#999' }} />
          </Tooltip>
        </Space>
      ),
      dataIndex: 'fc_diff',
      key: 'fc_diff',
      render: (value: number, record: TrialFcRow) => formatMoney(value, record.currency),
    },
    { title: t('currency.lineCount'), dataIndex: 'line_count', key: 'line_count' },
  ];

  const isBaseScope = scope === 'base';

  return (
    <div>
      <SuperTable
        columns={(isBaseScope ? baseColumns : fcColumns) as any}
        dataSource={(isBaseScope ? rows : fcRows) as any}
        rowKey={(record: any) => (isBaseScope ? String(record.period_id) : `${record.period_id}-${record.currency}`)}
        loading={loading}
        pagination={{ pageSize: 20 }}
        storageKey="finance-trial-balance"
        headerTitle={t('trialBalance.title')}
        queryBar={
          <Space wrap>
            <Segmented
              value={scope}
              onChange={(value) => setScope(value as Scope)}
              options={[
                { value: 'base', label: t('currency.scope.base') },
                { value: 'fc', label: t('currency.scope.byCurrency') },
              ]}
            />
            <Select
              allowClear
              placeholder={t('trialBalance.selectPeriod')}
              style={{ width: 180 }}
              value={periodId}
              onChange={(value) => {
                setPeriodId(value);
                fetchRows(value);
              }}
              options={periods.map((item) => ({ value: item.id, label: `${item.year}-${String(item.month).padStart(2, '0')}` }))}
            />
            {isBaseScope && (
              <Select
                allowClear
                placeholder={t('trialBalance.unbalancedOnly')}
                style={{ width: 180 }}
                options={[
                  { value: 'all', label: t('trialBalance.all') },
                  { value: 'diff', label: t('trialBalance.diffItems') },
                ]}
                onChange={(value) => {
                  if (value === 'diff') {
                    setRows((current) => current.filter((item) => Math.abs(item.balance_diff ?? 0) >= 0.005));
                  } else {
                    fetchRows(periodId);
                  }
                }}
              />
            )}
          </Space>
        }
      />
    </div>
  );
}
