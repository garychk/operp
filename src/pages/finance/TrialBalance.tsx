import { useEffect, useMemo, useState } from 'react';
import { Select, Space, Tag, message } from 'antd';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';


type Period = Tables['erp_accounting_periods_s_539dcf81_b']['Row'];
type TrialRow = {
  period_id: number | null;
  total_debit: number | null;
  total_credit: number | null;
  balance_diff: number | null;
};

export function TrialBalance() {
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
      message.error('获取试算平衡失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPeriods().catch((error) => {
      console.error(error);
      message.error('加载会计期间失败');
    });
    fetchRows();
  }, []);

  const periodMap = useMemo(() => new Map(periods.map((item) => [item.id, item])), [periods]);

  const columns = [
    { title: '会计期间', dataIndex: 'period_id', key: 'period_id', render: (value: number) => periodMap.get(value)?.year && periodMap.get(value)?.month ? `${periodMap.get(value)?.year}-${String(periodMap.get(value)?.month).padStart(2, '0')}` : value || '-' },
    { title: '借方合计', dataIndex: 'total_debit', key: 'total_debit', render: (value: number) => `¥${(value ?? 0).toFixed(2)}` },
    { title: '贷方合计', dataIndex: 'total_credit', key: 'total_credit', render: (value: number) => `¥${(value ?? 0).toFixed(2)}` },
    { title: '差额', dataIndex: 'balance_diff', key: 'balance_diff', render: (value: number) => <Tag color={Math.abs(value ?? 0) < 0.005 ? 'success' : 'error'}>{`¥${(value ?? 0).toFixed(2)}`}</Tag> },
  ];

  return (
    <div className="mainContent">
      <SuperTable
        columns={columns as any}
        dataSource={rows}
        rowKey={(record) => String(record.period_id)}
        loading={loading}
        pagination={{ pageSize: 20 }}
        storageKey="finance-trial-balance"
        headerTitle="试算平衡"
        queryBar={
          <Space wrap>
            <Select
              allowClear
              placeholder="选择期间"
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
              placeholder="只看借贷不平"
              style={{ width: 180 }}
              options={[
                { value: 'all', label: '全部' },
                { value: 'diff', label: '差异项' },
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
