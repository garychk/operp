import { useEffect, useMemo, useState } from 'react';
import { Select, Space, Tag, message } from 'antd';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { formatMoney } from '../../utils/money';


type Period = Tables['erp_accounting_periods_s_539dcf81_b']['Row'];
type TrialRow = {
  period_id: number | null;
  total_debit: number | null;
  total_credit: number | null;
  balance_diff: number | null;
};

export function TrialBalance() {
  const { t } = useTranslation();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [rows, setRows] = useState<TrialRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [periodId, setPeriodId] = useState<number | undefined>();

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
      let query = supabase.from('vw_erp_trial_balance' as any).select('*');
      if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
      const { data, error } = await query;
      if (error) throw error;
      setRows((data as TrialRow[]) || []);
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
    fetchRows();
  }, []);

  const periodMap = useMemo(() => new Map(periods.map((item) => [item.id, item])), [periods]);

  const columns = [
    { title: t('trialBalance.period'), dataIndex: 'period_id', key: 'period_id', render: (value: number) => periodMap.get(value)?.year && periodMap.get(value)?.month ? `${periodMap.get(value)?.year}-${String(periodMap.get(value)?.month).padStart(2, '0')}` : value || '-' },
    { title: t('trialBalance.totalDebit'), dataIndex: 'total_debit', key: 'total_debit', render: (value: number) => formatMoney(value) },
    { title: t('trialBalance.totalCredit'), dataIndex: 'total_credit', key: 'total_credit', render: (value: number) => formatMoney(value) },
    { title: t('trialBalance.difference'), dataIndex: 'balance_diff', key: 'balance_diff', render: (value: number) => <Tag color={Math.abs(value ?? 0) < 0.005 ? 'success' : 'error'}>{formatMoney(value)}</Tag> },
  ];

  return (
    <div>
      <SuperTable
        columns={columns as any}
        dataSource={rows}
        rowKey={(record) => String(record.period_id)}
        loading={loading}
        pagination={{ pageSize: 20 }}
        storageKey="finance-trial-balance"
        headerTitle={t('trialBalance.title')}
        queryBar={
          <Space wrap>
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
          </Space>
        }
      />
    </div>
  );
}
