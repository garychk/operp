import { useEffect, useMemo, useState } from 'react';
import { Button, Select, Space, Tabs, message, Tag, Card, Segmented } from 'antd';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { useCurrencyRegistry } from '../../utils/money';

type Period = Tables['erp_accounting_periods_s_539dcf81_b']['Row'];
type Subject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];
type SubjectBalance = {
  period_id: number | null;
  subject_id: number | null;
  debit_total: number | null;
  credit_total: number | null;
  net_amount: number | null;
};
/** 币种口径的科目发生额（vw_erp_gl_balance_fc） */
type SubjectBalanceFc = {
  period_id: number | null;
  subject_id: number | null;
  currency: string | null;
  fc_debit: number | null;
  fc_credit: number | null;
  line_count: number | null;
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
  /** deploy_75 起 vw_erp_ledger_detail 追加的双金额列 */
  currency: string | null;
  exchange_rate: number | null;
  debit_fc: number | null;
  credit_fc: number | null;
};

type Scope = 'base' | 'fc';

export function SubjectLedger() {
  const { t } = useTranslation();
  const { formatMoney, baseCurrency } = useCurrencyRegistry();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [balances, setBalances] = useState<SubjectBalance[]>([]);
  const [fcBalances, setFcBalances] = useState<SubjectBalanceFc[]>([]);
  const [details, setDetails] = useState<LedgerDetail[]>([]);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [periodId, setPeriodId] = useState<number | undefined>();
  const [subjectId, setSubjectId] = useState<number | undefined>();
  const [scope, setScope] = useState<Scope>('base');

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
      if (scope === 'fc') {
        // 按币种口径：vw_erp_gl_balance_fc 只含外币行，故这些合计是**原币**发生额
        let query = supabase.from('vw_erp_gl_balance_fc' as any).select('*');
        if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
        const { data, error } = await query;
        if (error) throw error;
        setFcBalances((data as SubjectBalanceFc[]) || []);
      } else {
        let query = supabase.from('vw_erp_subject_balance' as any).select('*');
        if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
        const { data, error } = await query;
        if (error) throw error;
        setBalances((data as SubjectBalance[]) || []);
      }
    } catch (error) {
      console.error(error);
      message.error(t('subjectLedger.fetchBalancesFailed'));
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
      message.error(t('subjectLedger.fetchDetailsFailed'));
    } finally {
      setLoadingDetails(false);
    }
  };

  useEffect(() => {
    fetchMeta().catch((error) => {
      console.error(error);
      message.error(t('subjectLedger.loadMetaFailed'));
    });
  }, []);

  // 口径切换要重新取数（两张视图粒度不同）。首屏也走这里。
  useEffect(() => {
    fetchBalances();
  }, [scope]);

  useEffect(() => {
    fetchDetails();
  }, []);

  const subjectMap = useMemo(() => new Map(subjects.map((item) => [item.id, item])), [subjects]);
  const periodMap = useMemo(() => new Map(periods.map((item) => [item.id, item])), [periods]);

  const periodLabel = (value: number | null) => {
    const period = value === null ? undefined : periodMap.get(value);
    return period?.year && period?.month
      ? `${period.year}-${String(period.month).padStart(2, '0')}`
      : value || '-';
  };
  const subjectLabel = (value: number | null) => {
    const subject = value === null ? undefined : subjectMap.get(value);
    return subject ? `${subject.code} - ${subject.name}` : value || '-';
  };

  const balanceColumns = [
    { title: t('subjectLedger.period'), dataIndex: 'period_id', key: 'period_id', render: periodLabel },
    { title: t('subjectLedger.subject'), dataIndex: 'subject_id', key: 'subject_id', render: subjectLabel },
    { title: t('currency.field.baseDebit'), dataIndex: 'debit_total', key: 'debit_total', render: (value: number) => formatMoney(value, baseCurrency) },
    { title: t('currency.field.baseCredit'), dataIndex: 'credit_total', key: 'credit_total', render: (value: number) => formatMoney(value, baseCurrency) },
    { title: t('subjectLedger.netAmount'), dataIndex: 'net_amount', key: 'net_amount', render: (value: number) => <Tag color={(value ?? 0) >= 0 ? 'success' : 'error'}>{formatMoney(value, baseCurrency)}</Tag> },
  ];

  const fcBalanceColumns = [
    { title: t('subjectLedger.period'), dataIndex: 'period_id', key: 'period_id', render: periodLabel },
    { title: t('subjectLedger.subject'), dataIndex: 'subject_id', key: 'subject_id', render: subjectLabel },
    {
      title: t('currency.field.currency'),
      dataIndex: 'currency',
      key: 'currency',
      render: (code: string) => code ? <Tag color="blue">{code}</Tag> : t('currency.baseTag'),
    },
    { title: t('currency.field.fcDebit'), dataIndex: 'fc_debit', key: 'fc_debit', render: (value: number, record: SubjectBalanceFc) => formatMoney(value, record.currency) },
    { title: t('currency.field.fcCredit'), dataIndex: 'fc_credit', key: 'fc_credit', render: (value: number, record: SubjectBalanceFc) => formatMoney(value, record.currency) },
    { title: t('currency.lineCount'), dataIndex: 'line_count', key: 'line_count' },
  ];

  const detailColumns = [
    { title: t('subjectLedger.date'), dataIndex: 'voucher_date', key: 'voucher_date' },
    { title: t('subjectLedger.voucherNo'), dataIndex: 'voucher_no', key: 'voucher_no' },
    { title: t('subjectLedger.summary'), dataIndex: 'summary', key: 'summary', ellipsis: true },
    {
      title: t('currency.field.currency'),
      dataIndex: 'currency',
      key: 'currency',
      width: 90,
      render: (code: string | null) => {
        const ccy = code ? String(code).trim().toUpperCase() : null;
        if (!ccy) return <Tag>{t('currency.baseTag')}</Tag>;
        return <Tag color="blue">{ccy}</Tag>;
      },
    },
    {
      title: t('currency.field.fcDebit'),
      dataIndex: 'debit_fc',
      key: 'debit_fc',
      width: 120,
      render: (value: number, record: LedgerDetail) =>
        record.currency && Number(value || 0) > 0 ? formatMoney(value, record.currency) : '-',
    },
    {
      title: t('currency.field.fcCredit'),
      dataIndex: 'credit_fc',
      key: 'credit_fc',
      width: 120,
      render: (value: number, record: LedgerDetail) =>
        record.currency && Number(value || 0) > 0 ? formatMoney(value, record.currency) : '-',
    },
    { title: t('currency.field.baseDebit'), dataIndex: 'debit_amount', key: 'debit_amount', render: (value: number) => formatMoney(value, baseCurrency) },
    { title: t('currency.field.baseCredit'), dataIndex: 'credit_amount', key: 'credit_amount', render: (value: number) => formatMoney(value, baseCurrency) },
    { title: t('subjectLedger.source'), dataIndex: 'source_type', key: 'source_type', render: (value: string) => value || '-' },
  ];

  const activeSubject = subjectId ? subjectMap.get(subjectId) : null;
  const isBaseScope = scope === 'base';

  return (
    <Card size='small' variant='borderless'>
      <Tabs
        tabPlacement='start'
        defaultActiveKey="balance"
        items={[
          {
            key: 'balance',
            label: t('subjectLedger.subjectBalance'),
            children: (
              <SuperTable
                columns={(isBaseScope ? balanceColumns : fcBalanceColumns) as any}
                dataSource={(isBaseScope ? balances : fcBalances) as any}
                rowKey={(record: any) => isBaseScope
                  ? `${record.period_id}-${record.subject_id}`
                  : `${record.period_id}-${record.subject_id}-${record.currency}`}
                loading={loadingBalances}
                pagination={{ pageSize: 20 }}
                storageKey="finance-subject-balance"
                headerTitle={t('subjectLedger.subjectBalance')}
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
                    <Select allowClear placeholder={t('subjectLedger.selectPeriod')} style={{ width: 160 }} value={periodId} onChange={(value) => { setPeriodId(value); fetchBalances(value); }} options={periods.map((item) => ({ value: item.id, label: `${item.year}-${String(item.month).padStart(2, '0')}` }))} />
                    <Select allowClear showSearch placeholder={t('subjectLedger.selectSubject')} style={{ width: 180 }} optionFilterProp="label" value={subjectId} onChange={(value) => setSubjectId(value)} options={subjects.map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` }))} />
                    <Button onClick={() => fetchBalances(periodId)}>{t('common.refresh')}</Button>
                  </Space>
                }
              />
            ),
          },
          {
            key: 'ledger',
            label: t('subjectLedger.ledgerDetail'),
            children: (
              <SuperTable
                columns={detailColumns as any}
                dataSource={details.filter((item) => !subjectId || item.subject_id === subjectId)}
                rowKey="id"
                loading={loadingDetails}
                pagination={{ pageSize: 20 }}
                storageKey="finance-ledger-detail"
                headerTitle={activeSubject ? `${t('subjectLedger.ledgerDetail')} - ${activeSubject.code} ${activeSubject.name}` : t('subjectLedger.ledgerDetail')}
                queryBar={
                  <Space wrap>
                    <Select allowClear placeholder={t('subjectLedger.selectPeriod')} style={{ width: 180 }} value={periodId} onChange={(value) => { setPeriodId(value); fetchDetails(value, subjectId); }} options={periods.map((item) => ({ value: item.id, label: `${item.year}-${String(item.month).padStart(2, '0')}` }))} />
                    <Select allowClear showSearch placeholder={t('subjectLedger.selectSubject')} style={{ width: 260 }} optionFilterProp="label" value={subjectId} onChange={(value) => { setSubjectId(value); fetchDetails(periodId, value); }} options={subjects.map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` }))} />
                    <Button onClick={() => fetchDetails(periodId, subjectId)}>{t('common.refresh')}</Button>
                  </Space>
                }
              />
            ),
          },
        ]}
      />
    </Card>
  );
}
