import { useEffect, useMemo, useState } from 'react';
import { Button, Form, Select, Space, message } from 'antd';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { formatMoney } from '../../utils/money';
import { useTranslation } from 'react-i18next';

type Period = Tables['erp_accounting_periods_s_539dcf81_b']['Row'];
type Subject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];
type GlBalance = {
  period_id: number | null;
  subject_id: number | null;
  period_debit: number | null;
  period_credit: number | null;
};

export function GeneralLedgerBalance() {
  const { t } = useTranslation();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [rows, setRows] = useState<GlBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  const fetchOptions = async () => {
    const [{ data: periodData }, { data: subjectData }] = await Promise.all([
      supabase.from('erp_accounting_periods_s_539dcf81_b').select('*').eq('is_deleted', 'n').order('year', { ascending: false }).order('month', { ascending: false }),
      supabase.from('erp_account_subjects_s_539dcf81_b').select('*').eq('is_deleted', 'n').eq('status', 'active').order('code'),
    ]);
    setPeriods((periodData as Period[]) || []);
    setSubjects((subjectData as Subject[]) || []);
  };

  const fetchRows = async (periodId?: number, subjectId?: number) => {
    setLoading(true);
    try {
      let query = supabase.from('vw_erp_gl_balance' as any).select('*');
      if (periodId) query = query.eq('period_id', periodId);
      if (subjectId) query = query.eq('subject_id', subjectId);
      const { data, error } = await query;
      if (error) throw error;
      setRows((data as GlBalance[]) || []);
    } catch (error) {
      console.error(error);
      message.error(t('glBalance.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOptions();
    fetchRows();
  }, []);

  const subjectMap = useMemo(() => new Map(subjects.map((item) => [item.id, item])), [subjects]);
  const periodMap = useMemo(() => new Map(periods.map((item) => [item.id, item])), [periods]);

  const columns = [
    { title: t('glBalance.accountingPeriod'), dataIndex: 'period_id', key: 'period_id', render: (value: number) => periodMap.get(value)?.year && periodMap.get(value)?.month ? `${periodMap.get(value)?.year}-${String(periodMap.get(value)?.month).padStart(2, '0')}` : value || '-' },
    { title: t('glBalance.accountSubject'), dataIndex: 'subject_id', key: 'subject_id', render: (value: number) => subjectMap.get(value) ? `${subjectMap.get(value)?.code} - ${subjectMap.get(value)?.name}` : value || '-' },
    { title: t('glBalance.periodDebit'), dataIndex: 'period_debit', key: 'period_debit', render: (value: number) => formatMoney(value) },
    { title: t('glBalance.periodCredit'), dataIndex: 'period_credit', key: 'period_credit', render: (value: number) => formatMoney(value) },
  ];

  return (
    <div>
      <SuperTable
        columns={columns as any}
        dataSource={rows}
        rowKey={(record) => `${record.period_id}-${record.subject_id}`}
        loading={loading}
        pagination={{ pageSize: 20 }}
        storageKey="finance-gl-balance"
        headerTitle={t('glBalance.title')}
        toolbarActions={[]}
        queryBar={
          <Space wrap>
            <Select
              allowClear
              placeholder={t('glBalance.selectPeriod')}
              style={{ width: 180 }}
              onChange={(value) => fetchRows(value, form.getFieldValue('subject_id'))}
              options={periods.map((item) => ({ value: item.id, label: `${item.year}-${String(item.month).padStart(2, '0')}` }))}
            />
            <Select
              allowClear
              showSearch
              placeholder={t('glBalance.selectSubject')}
              style={{ width: 260 }}
              optionFilterProp="label"
              onChange={(value) => fetchRows(form.getFieldValue('period_id'), value)}
              options={subjects.map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` }))}
            />
            <Button onClick={() => fetchRows(form.getFieldValue('period_id'), form.getFieldValue('subject_id'))}>{t('glBalance.refresh')}</Button>
          </Space>
        }
      />
    </div>
  );
}
