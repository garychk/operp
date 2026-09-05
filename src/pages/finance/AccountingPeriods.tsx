import { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Modal, Space, Tag, message } from 'antd';
import { CheckOutlined, LockOutlined, UnlockOutlined, ReloadOutlined } from '@ant-design/icons';
import { supabase } from '@/utils/supabase';
import { generateIdempotencyKey } from '@/utils/uuid';
import type { Tables } from '@/utils/supabase';
import { SuperTable } from '@/components/SuperTable';
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
      message.warning('请输入有效的会计年度');
      return;
    }
    setGenerating(true);
    try {
      const { error } = await supabase.rpc('generate_accounting_periods', {
        p_year: generationYear,
        p_idempotency_key: generateIdempotencyKey(),
      });
      if (error) throw error;
      message.success('会计年度生成成功');
      await fetchRows();
    } catch (error: any) {
      console.error(error);
      message.error(error?.message || '生成会计期间失败');
    } finally {
      setGenerating(false);
    }
  };
  const handleAction = (action: 'enable' | 'close' | 'lock', record: Period) => {
    const actionLabels = {
      enable: '启用期间',
      close: '结账期间',
      lock: '关账期间',
    } as const;
    Modal.confirm({
      title: `确认${actionLabels[action]}`,
      content:
        action === 'enable'
          ? '启用后该期间可进行正常记账。'
          : action === 'close'
            ? '结账后该期间将禁止继续过账。'
            : '关账后该期间将进入锁定状态，禁止继续修改。',
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
      title: '期间',
      key: 'period',
      width: 120,
      render: (_: any, record: Period) => `${record.year}-${String(record.month).padStart(2, '0')}`,
    },
    { title: '起始日期', dataIndex: 'start_date', key: 'start_date', width: 120 },
    { title: '结束日期', dataIndex: 'end_date', key: 'end_date', width: 120 },
    {
      title: '启用状态',
      dataIndex: 'is_enabled',
      key: 'is_enabled',
      width: 120,
      render: (value: boolean) => <Tag color={value ? 'success' : 'default'}>{value ? '已启用' : '未启用'}</Tag>,
    },
    {
      title: '结账状态',
      dataIndex: 'is_closed',
      key: 'is_closed',
      width: 120,
      render: (value: boolean) => <Tag color={value ? 'warning' : 'default'}>{value ? '已结账' : '未结账'}</Tag>,
    },
    {
      title: '关账状态',
      dataIndex: 'is_locked',
      key: 'is_locked',
      render: (value: boolean) => <Tag color={value ? 'error' : 'default'}>{value ? '已关账' : '未关账'}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      fixed: 'right',
      render: (_: any, record: Period) => (
        <Space size="middle">
          <Button type="text" icon={<CheckOutlined />} onClick={() => handleAction('enable', record)} disabled={!!record.is_locked}>
            启用
          </Button>
          <Button type="text" icon={<LockOutlined />} onClick={() => handleAction('close', record)} disabled={!record.is_enabled || !!record.is_locked}>
            结账
          </Button>
          <Button type="text" danger icon={<UnlockOutlined />} onClick={() => handleAction('lock', record)} disabled={!record.is_closed || !!record.is_locked}>
            关账
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
            <InputNumber min={1900} max={2999} value={generationYear} onChange={(value) => setGenerationYear(value || new Date().getFullYear())} addonAfter="年" />
            <Button type="primary" loading={generating} onClick={handleGenerateYear}>生成年度期间</Button>
            <Button icon={<ReloadOutlined />} onClick={fetchRows}>{'刷新'}</Button>
            <Input.Search
              allowClear
              placeholder="搜索期间，例如 2026-08"
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

