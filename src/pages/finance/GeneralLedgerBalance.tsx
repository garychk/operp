import { useEffect, useMemo, useState } from 'react';
import { Button, Select, Space, Tag, message, Segmented } from 'antd';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { useCurrencyRegistry } from '../../utils/money';
import { useTranslation } from 'react-i18next';

type Period = Tables['erp_accounting_periods_s_539dcf81_b']['Row'];
type Subject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];

/** 本位币口径（vw_erp_gl_balance，deploy_75 起带 tenant_id） */
type GlBalance = {
  period_id: number | null;
  subject_id: number | null;
  period_debit: number | null;
  period_credit: number | null;
};

/** 币种口径（vw_erp_gl_balance_fc，deploy_77）：只含外币行的原币发生额 */
type GlBalanceFc = {
  period_id: number | null;
  subject_id: number | null;
  currency: string | null;
  fc_debit: number | null;
  fc_credit: number | null;
  line_count: number | null;
};

type Scope = 'base' | 'fc';

export function GeneralLedgerBalance() {
  const { t } = useTranslation();
  const { formatMoney, baseCurrency } = useCurrencyRegistry();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [rows, setRows] = useState<GlBalance[]>([]);
  const [fcRows, setFcRows] = useState<GlBalanceFc[]>([]);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<Scope>('base');
  // 用 state 而不是 Form.getFieldValue：这个页面没有渲染 <Form>，
  // 之前那套 form.getFieldValue(...) 永远取到 undefined，期间/科目筛选实际是失效的
  const [periodId, setPeriodId] = useState<number | undefined>();
  const [subjectId, setSubjectId] = useState<number | undefined>();

  const fetchOptions = async () => {
    const [{ data: periodData }, { data: subjectData }] = await Promise.all([
      supabase.from('erp_accounting_periods_s_539dcf81_b').select('*').eq('is_deleted', 'n').order('year', { ascending: false }).order('month', { ascending: false }),
      supabase.from('erp_account_subjects_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active').order('code'),
    ]);
    setPeriods((periodData as Period[]) || []);
    setSubjects((subjectData as Subject[]) || []);
  };

  const fetchRows = async (nextPeriodId?: number, nextSubjectId?: number) => {
    setLoading(true);
    try {
      if (scope === 'fc') {
        let query = supabase.from('vw_erp_gl_balance_fc' as any).select('*');
        if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
        if (nextSubjectId) query = query.eq('subject_id', nextSubjectId);
        const { data, error } = await query;
        if (error) throw error;
        setFcRows((data as GlBalanceFc[]) || []);
      } else {
        let query = supabase.from('vw_erp_gl_balance' as any).select('*');
        if (nextPeriodId) query = query.eq('period_id', nextPeriodId);
        if (nextSubjectId) query = query.eq('subject_id', nextSubjectId);
        const { data, error } = await query;
        if (error) throw error;
        setRows((data as GlBalance[]) || []);
      }
    } catch (error) {
      console.error(error);
      message.error(t('glBalance.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOptions();
  }, []);

  // 口径变了必须重新取数（两张视图的粒度不同）。首屏也走这里。
  useEffect(() => {
    fetchRows();
  }, [scope]);

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

  const baseColumns = [
    { title: t('glBalance.accountingPeriod'), dataIndex: 'period_id', key: 'period_id', render: periodLabel },
    { title: t('glBalance.accountSubject'), dataIndex: 'subject_id', key: 'subject_id', render: subjectLabel },
    { title: t('currency.field.baseDebit'), dataIndex: 'period_debit', key: 'period_debit', render: (value: number) => formatMoney(value, baseCurrency) },
    { title: t('currency.field.baseCredit'), dataIndex: 'period_credit', key: 'period_credit', render: (value: number) => formatMoney(value, baseCurrency) },
  ];

  const fcColumns = [
    { title: t('glBalance.accountingPeriod'), dataIndex: 'period_id', key: 'period_id', render: periodLabel },
    { title: t('glBalance.accountSubject'), dataIndex: 'subject_id', key: 'subject_id', render: subjectLabel },
    {
      title: t('currency.field.currency'),
      dataIndex: 'currency',
      key: 'currency',
      render: (code: string) => code ? <Tag color="blue">{code}</Tag> : t('currency.baseTag'),
    },
    { title: t('currency.field.fcDebit'), dataIndex: 'fc_debit', key: 'fc_debit', render: (value: number, record: GlBalanceFc) => formatMoney(value, record.currency) },
    { title: t('currency.field.fcCredit'), dataIndex: 'fc_credit', key: 'fc_credit', render: (value: number, record: GlBalanceFc) => formatMoney(value, record.currency) },
    { title: t('currency.lineCount'), dataIndex: 'line_count', key: 'line_count' },
  ];

  const isBaseScope = scope === 'base';

  return (
    <div>
      <SuperTable
        columns={(isBaseScope ? baseColumns : fcColumns) as any}
        dataSource={(isBaseScope ? rows : fcRows) as any}
        rowKey={(record: any) => (isBaseScope ? `${record.period_id}-${record.subject_id}` : `${record.period_id}-${record.subject_id}-${record.currency}`)}
        loading={loading}
        pagination={{ pageSize: 20 }}
        storageKey="finance-gl-balance"
        headerTitle={t('glBalance.title')}
        toolbarActions={[]}
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
              placeholder={t('glBalance.selectPeriod')}
              style={{ width: 180 }}
              value={periodId}
              onChange={(value) => { setPeriodId(value); fetchRows(value, subjectId); }}
              options={periods.map((item) => ({ value: item.id, label: `${item.year}-${String(item.month).padStart(2, '0')}` }))}
            />
            <Select
              allowClear
              showSearch
              placeholder={t('glBalance.selectSubject')}
              style={{ width: 260 }}
              optionFilterProp="label"
              value={subjectId}
              onChange={(value) => { setSubjectId(value); fetchRows(periodId, value); }}
              options={subjects.map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` }))}
            />
            <Button onClick={() => fetchRows(periodId, subjectId)}>{t('glBalance.refresh')}</Button>
          </Space>
        }
      />
    </div>
  );
}
