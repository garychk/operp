import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Card, DatePicker, Input, Button, Space, Tag, message, Statistic, Row, Col } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { supabase } from '../../utils/supabase';
import { useAuth } from '../../contexts/AuthContext';

interface TokenUsageRow {
  id: number;
  tenant_id: number | null;
  user_id: number | null;
  session_id: string | null;
  operation: string;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
}

interface UserOption {
  id: number;
  username: string;
}

export function TokenUsage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [rows, setRows] = useState<TokenUsageRow[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [searchUser, setSearchUser] = useState('');
  const [searchModel, setSearchModel] = useState('');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20 });

  // 角色判定：超管看全部租户；租户管理员看本租户全部用户；普通用户只看自己
  const isSuperAdmin = user?.isSuperAdmin === true;
  const isTenantAdmin = user?.roles?.some((r) => r.role_code === 'tenant_admin') === true;
  const canSeeOthers = isSuperAdmin || isTenantAdmin;

  const operationLabel = (op: string) => t(`tokenUsage.op.${op}`, op) as string;

  const fetchUsers = async () => {
    if (!canSeeOthers) return;
    // 超管看全部租户用户，租户管理员只看本租户（RLS 也会兜底）
    let query = supabase.from('sys_users').select('id, username').eq('is_deleted', 'n');
    const { data, error } = await query;
    if (error) {
      console.error('Failed to fetch users:', error);
      return;
    }
    setUsers((data as UserOption[]) || []);
  };

  const fetchRows = async (page = 1, pageSize = 20) => {
    setLoading(true);
    try {
      let query = supabase
        .from('sys_ai_token_usage')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      // 普通用户：只看自己（RLS 已兜底，这里再显式过滤一次更稳）
      if (!canSeeOthers && user?.profile?.id) {
        query = query.eq('user_id', user.profile.id);
      }
      if (canSeeOthers && searchUser) {
        query = query.eq('user_id', searchUser);
      }
      if (searchModel) {
        query = query.ilike('model', `%${searchModel}%`);
      }
      if (dateRange && dateRange[0] && dateRange[1]) {
        query = query
          .gte('created_at', dateRange[0].startOf('day').toISOString())
          .lte('created_at', dateRange[1].endOf('day').toISOString());
      }

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);

      if (error) throw error;
      setRows((data as TokenUsageRow[]) || []);
      setTotal(count || 0);
    } catch (error) {
      message.error(t('tokenUsage.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows(pagination.current, pagination.pageSize);
    fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeOthers]);

  // 当前页合计（供统计卡片用）
  const pageTotals = useMemo(() => {
    const p = rows.reduce((acc, r) => acc + (r.prompt_tokens || 0), 0);
    const c = rows.reduce((acc, r) => acc + (r.completion_tokens || 0), 0);
    return { prompt: p, completion: c, total: p + c };
  }, [rows]);

  const handleSearch = () => {
    setPagination({ current: 1, pageSize: pagination.pageSize });
    fetchRows(1, pagination.pageSize);
  };

  const handleReset = () => {
    setSearchUser('');
    setSearchModel('');
    setDateRange(null);
    setPagination({ current: 1, pageSize: pagination.pageSize });
    fetchRows(1, pagination.pageSize);
  };

  const handlePageChange = (page: number, pageSize: number) => {
    setPagination({ current: page, pageSize });
    fetchRows(page, pageSize);
  };

  const columns: ColumnsType<TokenUsageRow> = [
    {
      title: t('tokenUsage.time'),
      dataIndex: 'created_at',
      width: 180,
      render: (date) => new Date(date).toLocaleString(),
    },
    {
      title: t('tokenUsage.user'),
      dataIndex: 'user_id',
      width: 120,
      render: (uid) => {
        if (uid == null) return '-';
        const u = users.find((x) => x.id === Number(uid));
        return u ? u.username : `#${uid}`;
      },
    },
    {
      title: t('tokenUsage.operation'),
      dataIndex: 'operation',
      width: 130,
      render: (op) => <Tag>{operationLabel(op)}</Tag>,
    },
    {
      title: t('tokenUsage.model'),
      dataIndex: 'model',
      width: 160,
      ellipsis: true,
      render: (m) => m || '-',
    },
    {
      title: t('tokenUsage.promptTokens'),
      dataIndex: 'prompt_tokens',
      width: 120,
      align: 'right',
      render: (v) => (v ?? 0).toLocaleString(),
    },
    {
      title: t('tokenUsage.completionTokens'),
      dataIndex: 'completion_tokens',
      width: 130,
      align: 'right',
      render: (v) => (v ?? 0).toLocaleString(),
    },
    {
      title: t('tokenUsage.totalTokens'),
      dataIndex: 'total_tokens',
      width: 120,
      align: 'right',
      render: (v) => (v ?? 0).toLocaleString(),
    },
  ];

  return (
    <Card variant="borderless" title={t('tokenUsage.title')} extra={
      <Space size="middle">
        {canSeeOthers && (
          <Input
            placeholder={t('tokenUsage.userPlaceholder')}
            value={searchUser}
            onChange={(e) => setSearchUser(e.target.value)}
            style={{ width: 140 }}
          />
        )}
        <Input
          placeholder={t('tokenUsage.modelPlaceholder')}
          value={searchModel}
          onChange={(e) => setSearchModel(e.target.value)}
          style={{ width: 160 }}
        />
        <DatePicker.RangePicker
          value={dateRange}
          onChange={(dates) => setDateRange(dates as [Dayjs | null, Dayjs | null] | null)}
        />
        <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
          {t('tokenUsage.search')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={handleReset}>
          {t('common.reset')}
        </Button>
      </Space>
    }>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Statistic title={t('tokenUsage.pagePromptTotal')} value={pageTotals.prompt} />
        </Col>
        <Col span={8}>
          <Statistic title={t('tokenUsage.pageCompletionTotal')} value={pageTotals.completion} />
        </Col>
        <Col span={8}>
          <Statistic title={t('tokenUsage.pageTotal')} value={pageTotals.total} />
        </Col>
      </Row>
      <Table
        columns={columns}
        dataSource={rows}
        loading={loading}
        rowKey="id"
        size="small"
        scroll={{ x: 1000, y: 500 }}
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          showSizeChanger: true,
          pageSizeOptions: ['10', '20', '50', '100'],
          showTotal: (total) => t('tokenUsage.total', { total }),
          total,
          onChange: handlePageChange,
        }}
      />
    </Card>
  );
}
