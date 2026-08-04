import { useEffect, useMemo, useState } from 'react';
import { Button, DatePicker, Select, Space, Tabs, message, Tag, Card } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';

const { Option } = Select;

type Period = Tables['erp_accounting_periods_s_539dcf81_b']['Row'];
type Subject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];
type SubjectBalance = {
  period_id: number | null;
  subject_id: number | null;
  debit_total: number | null;
  credit_total: number | null;
  net_amount: number | null;
};
type LedgerDetail = {
  id: number;
  period_id: number | null;
  subject_id: number | null;
  voucher_id: number | null;
  voucher_detail_id: number | null;
  voucher_no: string;
  voucher_date: string;
  summary: string | null;
  debit_amount: number | null;
  credit_amount: number | null;
  source_type: string | null;
  source_id: number | null;
  source_detail_id: number | null;
  posted_at: string | null;
  posted_by: number | null;
};

export function SubjectLedger() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [balances, setBalances] = useState<SubjectBalance[]>([]);
  const [details, setDetails] = useState<LedgerDetail[]>([]);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [periodId, setPeriodId] = useState<number | undefined>();
  const [subjectId, setSubjectId] = useState<number | undefined>();

  const fetchMeta = async () => {
    const [{ data: periodData }, { data: subjectData }] = await Promise.all([
      supabase.from('erp_accounting_periods_s_539dcf81_b').select('*').eq('is_deleted', 'n').order('year', { ascending: false }).order('month', { ascending: false }),
      supabase.from('erp_account_subjects_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active').order('code'),
    ]);
    setPeriods((periodData as Period[]) || []);
    setSubjects((subjectData as Subject[]) || []);
  };

  const fetchBalances = async (nextPeriodId?: number) => {
    setLoadingBalances(true);
    try {
      let query = supabase.from('vw_erp_subject_balance' as any).select('*');
      if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
      const { data, error } = await query;
      if (error) throw error;
      setBalances((data as SubjectBalance[]) || []);
    } catch (error) {
      console.error(error);
      message.error('获取科目余额失败');
    } finally {
      setLoadingBalances(false);
    }
  };

  const fetchDetails = async (nextPeriodId?: number, nextSubjectId?: number) => {
    setLoadingDetails(true);
    try {
      let query = supabase.from('vw_erp_ledger_detail' as any).select('*').order('voucher_date', { ascending: true }).order('id', { ascending: true });
      if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
      if (nextSubjectId) query = query.eq('subject_id', nextSubjectId);
      const { data, error } = await query;
      if (error) throw error;
      setDetails((data as LedgerDetail[]) || []);
    } catch (error) {
      console.error(error);
      message.error('获取明细账失败');
    } finally {
      setLoadingDetails(false);
    }
  };

  useEffect(() => {
    fetchMeta().catch((error) => {
      console.error(error);
      message.error('加载基础数据失败');
    });
    fetchBalances();
    fetchDetails();
  }, []);

  const subjectMap = useMemo(() => new Map(subjects.map((item) => [item.id, item])), [subjects]);
  const periodMap = useMemo(() => new Map(periods.map((item) => [item.id, item])), [periods]);

  const balanceColumns = [
    { title: '会计期间', dataIndex: 'period_id', key: 'period_id', render: (value: number) => periodMap.get(value)?.year && periodMap.get(value)?.month ? `${periodMap.get(value)?.year}-${String(periodMap.get(value)?.month).padStart(2, '0')}` : value || '-' },
    { title: '会计科目', dataIndex: 'subject_id', key: 'subject_id', render: (value: number) => subjectMap.get(value) ? `${subjectMap.get(value)?.code} - ${subjectMap.get(value)?.name}` : value || '-' },
    { title: '借方合计', dataIndex: 'debit_total', key: 'debit_total', render: (value: number) => `¥${(value ?? 0).toFixed(2)}` },
    { title: '贷方合计', dataIndex: 'credit_total', key: 'credit_total', render: (value: number) => `¥${(value ?? 0).toFixed(2)}` },
    { title: '净额', dataIndex: 'net_amount', key: 'net_amount', render: (value: number) => <Tag color={(value ?? 0) >= 0 ? 'success' : 'error'}>{`¥${(value ?? 0).toFixed(2)}`}</Tag> },
  ];

  const detailColumns = [
    { title: '日期', dataIndex: 'voucher_date', key: 'voucher_date' },
    { title: '凭证号', dataIndex: 'voucher_no', key: 'voucher_no' },
    { title: '摘要', dataIndex: 'summary', key: 'summary', ellipsis: true },
    { title: '借方', dataIndex: 'debit_amount', key: 'debit_amount', render: (value: number) => `¥${(value ?? 0).toFixed(2)}` },
    { title: '贷方', dataIndex: 'credit_amount', key: 'credit_amount', render: (value: number) => `¥${(value ?? 0).toFixed(2)}` },
    { title: '来源', dataIndex: 'source_type', key: 'source_type', render: (value: string) => value || '-' },
  ];

  const activeSubject = subjectId ? subjectMap.get(subjectId) : null;

  return (
    <div className="mainContent">
      <Card size='small' variant='borderless'>
      <Tabs
        defaultActiveKey="balance"
        items={[
          {
            key: 'balance',
            label: '科目余额',
            children: (
              <SuperTable
                columns={balanceColumns as any}
                dataSource={balances}
                rowKey={(record) => `${record.period_id}-${record.subject_id}`}
                loading={loadingBalances}
                pagination={{ pageSize: 20 }}
                storageKey="finance-subject-balance"
                headerTitle="科目余额"
                queryBar={
                  <Space wrap>
                    <Select
                      allowClear
                      placeholder="选择期间"
                      style={{ width: 180 }}
                      value={periodId}
                      onChange={(value) => {
                        setPeriodId(value);
                        fetchBalances(value);
                      }}
                      options={periods.map((item) => ({ value: item.id, label: `${item.year}-${String(item.month).padStart(2, '0')}` }))}
                    />
                    <Select
                      allowClear
                      showSearch
                      placeholder="选择科目"
                      style={{ width: 260 }}
                      optionFilterProp="label"
                      value={subjectId}
                      onChange={(value) => setSubjectId(value)}
                      options={subjects.map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` }))}
                    />
                    <Button onClick={() => fetchBalances(periodId)}>刷新</Button>
                  </Space>
                }
              />
            ),
          },
          {
            key: 'ledger',
            label: '明细账',
            children: (
              <SuperTable
                columns={detailColumns as any}
                dataSource={details.filter((item) => !subjectId || item.subject_id === subjectId)}
                rowKey="id"
                loading={loadingDetails}
                pagination={{ pageSize: 20 }}
                storageKey="finance-ledger-detail"
                headerTitle={activeSubject ? `明细账 - ${activeSubject.code} ${activeSubject.name}` : '明细账'}
                queryBar={
                  <Space wrap>
                    <Select
                      allowClear
                      placeholder="选择期间"
                      style={{ width: 180 }}
                      value={periodId}
                      onChange={(value) => {
                        setPeriodId(value);
                        fetchDetails(value, subjectId);
                      }}
                      options={periods.map((item) => ({ value: item.id, label: `${item.year}-${String(item.month).padStart(2, '0')}` }))}
                    />
                    <Select
                      allowClear
                      showSearch
                      placeholder="选择科目"
                      style={{ width: 260 }}
                      optionFilterProp="label"
                      value={subjectId}
                      onChange={(value) => {
                        setSubjectId(value);
                        fetchDetails(periodId, value);
                      }}
                      options={subjects.map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` }))}
                    />
                    <Button onClick={() => fetchDetails(periodId, subjectId)}>刷新</Button>
                  </Space>
                }
              />
            ),
          },
        ]}
      />
      </Card>
    </div>
  );
}
