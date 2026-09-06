import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Modal, Space, Tag, message } from 'antd';
import { CheckOutlined, LockOutlined, UnlockOutlined, ReloadOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { generateIdempotencyKey } from '../../utils/uuid';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { useTranslation } from 'react-i18next';

type Period = Tables['erp_accounting_periods_s_539dcf81_b']['Row'];

export function AccountingPeriods() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Period[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([]);
  const [generationYear, setGenerationYear] = useState(new Date().getFullYear());
  const [generating, setGenerating] = useState(false);

  const fetchRows = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('erp_accounting_periods_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('year', { ascending: false })
        .order('month', { ascending: false });
      if (error) throw error;
      setRows((data as Period[]) || []);
    } catch (error) {
      console.error(error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows();
  }, []);

  const handleGenerateYear = async () => {
    if (!generationYear || generationYear < 1900 || generationYear > 2999) {
      message.warning(t('accountingPeriods.validYearWarning'));
      return;
    }
    setGenerating(true);
    try {
      const { error } = await supabase.rpc('generate_accounting_periods', {
        p_year: generationYear,
        p_idempotency_key: generateIdempotencyKey(),
      });
      if (error) throw error;
      message.success(t('accountingPeriods.messages.generateSuccess'));
      await fetchRows();
    } catch (error: any) {
      console.error(error);
      message.error(error?.message || t('accountingPeriods.messages.generateFailed'));
    } finally {
      setGenerating(false);
    }
  };
  const handleAction = (action: 'enable' | 'close' | 'lock', record: Period) => {
    const actionLabels = {
      enable: t('accountingPeriods.enablePeriod'),
      close: t('accountingPeriods.closePeriod'),
      lock: t('accountingPeriods.lockPeriod'),
    } as const;
    Modal.confirm({
      title: t('accountingPeriods.confirmTitle', { action: actionLabels[action] }),
      content: t(
        action === 'enable'
          ? 'accountingPeriods.enableContent'
          : action === 'close'
            ? 'accountingPeriods.closeContent'
            : 'accountingPeriods.lockContent',
      ),
      onOk: async () => {
        try {
          const rpcName = action === 'enable' ? 'enable_accounting_period' : action === 'close' ? 'close_accounting_period' : 'lock_accounting_period';
          const { error } = await supabase.rpc(rpcName, {
            p_period_id: record.id,
            p_idempotency_key: generateIdempotencyKey(),
          });
          if (error) throw error;
          message.success(t('common.updateSuccess'));
          fetchRows();
        } catch (error: any) {
          console.error(error);
          message.error(error?.message || t('common.saveFailed'));
        }
      },
    });
  };

  const filteredRows = rows.filter((row) => {
    const term = searchTerm.trim();
    if (!term) return true;
    return `${row.year}-${String(row.month).padStart(2, '0')}`.includes(term);
  });

  const columns = [
    {
      title: t('accountingPeriods.period'),
      key: 'period',
      width: 120,
      render: (_: any, record: Period) => `${record.year}-${String(record.month).padStart(2, '0')}`,
    },
    { title: t('accountingPeriods.startDate'), dataIndex: 'start_date', key: 'start_date', width: 120 },
    { title: t('accountingPeriods.endDate'), dataIndex: 'end_date', key: 'end_date', width: 120 },
    {
      title: t('accountingPeriods.enabledStatus'),
      dataIndex: 'is_enabled',
      key: 'is_enabled',
      width: 120,
      render: (value: boolean) => <Tag color={value ? 'success' : 'default'}>{value ? t('accountingPeriods.enabled') : t('accountingPeriods.notEnabled')}</Tag>,
    },
    {
      title: t('accountingPeriods.closedStatus'),
      dataIndex: 'is_closed',
      key: 'is_closed',
      width: 120,
      render: (value: boolean) => <Tag color={value ? 'warning' : 'default'}>{value ? t('accountingPeriods.closed') : t('accountingPeriods.notClosed')}</Tag>,
    },
    {
      title: t('accountingPeriods.lockedStatus'),
      dataIndex: 'is_locked',
      key: 'is_locked',
      render: (value: boolean) => <Tag color={value ? 'error' : 'default'}>{value ? t('accountingPeriods.locked') : t('accountingPeriods.notLocked')}</Tag>,
    },
    {
      title: t('common.actions'),
      key: 'action',
      width: 200,
      fixed: 'right',
      render: (_: any, record: Period) => (
        <Space size="middle">
          <Button type="text" icon={<CheckOutlined />} onClick={() => handleAction('enable', record)} disabled={!!record.is_locked}>
            {t('accountingPeriods.enable')}
          </Button>
          <Button type="text" icon={<LockOutlined />} onClick={() => handleAction('close', record)} disabled={!record.is_enabled || !!record.is_locked}>
            {t('accountingPeriods.close')}
          </Button>
          <Button type="text" danger icon={<UnlockOutlined />} onClick={() => handleAction('lock', record)} disabled={!record.is_closed || !!record.is_locked}>
            {t('accountingPeriods.lock')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="mainContent">
      <SuperTable
        columns={columns as any}
        dataSource={filteredRows}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 20 }}
        storageKey="finance-accounting-periods"
        headerTitle={t('menu.periods')}
        scroll={{ y: 640, x: "max-content" }}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys as number[]),
        }}
        queryBar={
          <Space wrap>
            <InputNumber min={1900} max={2999} value={generationYear} onChange={(value) => setGenerationYear(value || new Date().getFullYear())} addonAfter={t('accountingPeriods.yearUnit')} />
            <Button type="primary" loading={generating} onClick={handleGenerateYear}>{t('accountingPeriods.generateYear')}</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchRows}>{t('common.refresh')}</Button>
            <Input.Search
              allowClear
              placeholder={t('accountingPeriods.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchRows}
              style={{ width: 220 }}
            />
          </Space>
        }
      />
    </div>
  );
}
