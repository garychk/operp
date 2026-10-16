import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Card, DatePicker, Input, Button, Space, Tag, message, Statistic, Row, Col } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { Line, Pie } from '@ant-design/charts';
import { supabase } from '../../utils/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useErpDarkMode } from '../../hooks/useErpDarkMode';

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
  // 图表聚合数据：按用途（operation）、按日（created_at 的日期部分）
  const [operationStats, setOperationStats] = useState<{ operation: string; tokens: number }[]>([]);
  const [dailyStats, setDailyStats] = useState<{ date: string; tokens: number }[]>([]);

  // 角色判定：超管看全部租户；租户管理员看本租户全部用户；普通用户只看自己
  const isSuperAdmin = user?.isSuperAdmin === true;
  const isTenantAdmin = user?.roles?.some((r) => r.role_code === 'tenant_admin') === true;
  const canSeeOthers = isSuperAdmin || isTenantAdmin;

  const operationLabel = (op: string) => t(`tokenUsage.op.${op}`, op) as string;
  const dark = useErpDarkMode();

  // 共用的筛选条件：图表与明细表保持同一口径，避免「图里一个数、表里另一个数」。
  // 用宽松类型承载 Supabase 查询构造器（.eq/.ilike/.gte/.lte/.range 链式返回类型复杂）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyFilters = (query: any) => {
    let q = query;
    // 普通用户：只看自己（RLS 已兜底，这里再显式过滤一次更稳）
    if (!canSeeOthers && user?.profile?.id) {
      q = q.eq('user_id', user.profile.id);
    }
    if (canSeeOthers && searchUser) {
      q = q.eq('user_id', searchUser);
    }
    if (searchModel) {
      q = q.ilike('model', `%${searchModel}%`);
    }
    if (dateRange && dateRange[0] && dateRange[1]) {
      q = q
        .gte('created_at', dateRange[0].startOf('day').toISOString())
        .lte('created_at', dateRange[1].endOf('day').toISOString());
    }
    return q;
  };

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
      query = applyFilters(query);

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

  // 图表聚合：拉全量轻量字段（operation / total_tokens / created_at）后在前端聚合。
  // 不用分页，确保饼图/曲线图覆盖当前筛选下的完整数据，而不是只有当前页 20 条。
  const fetchCharts = async () => {
    try {
      let query = supabase
        .from('sys_ai_token_usage')
        .select('operation, total_tokens, created_at');
      query = applyFilters(query);

      const { data, error } = await query;
      if (error) throw error;

      const rowsData = (data || []) as Pick<TokenUsageRow, 'operation' | 'total_tokens' | 'created_at'>[];

      // 按用途聚合
      const opMap = new Map<string, number>();
      // 按日聚合（用 UTC 日期，避免本地时区把 created_at 拆到两天）
      const dayMap = new Map<string, number>();
      for (const row of rowsData) {
        const tokens = Number(row.total_tokens) || 0;
        const op = row.operation || 'chat';
        opMap.set(op, (opMap.get(op) || 0) + tokens);

        const day = new Date(row.created_at).toISOString().slice(0, 10);
        dayMap.set(day, (dayMap.get(day) || 0) + tokens);
      }

      setOperationStats(
        Array.from(opMap.entries())
          .map(([operation, tokens]) => ({ operation, tokens }))
          .sort((a, b) => b.tokens - a.tokens),
      );

      setDailyStats(
        Array.from(dayMap.entries())
          .map(([date, tokens]) => ({ date, tokens }))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      );
    } catch (error) {
      console.error('Failed to fetch token charts:', error);
    }
  };

  useEffect(() => {
    fetchRows(pagination.current, pagination.pageSize);
    fetchUsers();
    fetchCharts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeOthers]);

  // 当前页合计（供统计卡片用）
  const pageTotals = useMemo(() => {
    const p = rows.reduce((acc, r) => acc + (r.prompt_tokens || 0), 0);
    const c = rows.reduce((acc, r) => acc + (r.completion_tokens || 0), 0);
    return { prompt: p, completion: c, total: p + c };
  }, [rows]);

  // 图表数据（带本地化标签）
  const pieData = useMemo(
    () =>
      operationStats.map((item) => ({
        operation: operationLabel(item.operation),
        tokens: item.tokens,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [operationStats],
  );
  const lineData = useMemo(
    () => dailyStats.map((item) => ({ date: item.date, tokens: item.tokens })),
    [dailyStats],
  );

  const chartTheme = dark ? 'classicDark' : 'classic';
  const chartHeight = 260;

  const handleSearch = () => {
    setPagination({ current: 1, pageSize: pagination.pageSize });
    fetchRows(1, pagination.pageSize);
    fetchCharts();
  };

  const handleReset = () => {
    setSearchUser('');
    setSearchModel('');
    setDateRange(null);
    setPagination({ current: 1, pageSize: pagination.pageSize });
    fetchRows(1, pagination.pageSize);
    fetchCharts();
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
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Card variant="borderless" size="small" title={t('tokenUsage.byOperation')}>
            {pieData.length ? (
              <Pie
                data={pieData}
                angleField="tokens"
                colorField="operation"
                innerRadius={0.55}
                autoFit
                height={chartHeight}
                theme={chartTheme}
                legend={{ color: { position: 'bottom' } }}
                label={{ text: 'tokens', style: { fontSize: 11, fontWeight: 600 } }}
              />
            ) : (
              <div style={{ height: chartHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
                {t('tokenUsage.noChartData')}
              </div>
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card variant="borderless" size="small" title={t('tokenUsage.dailyTrend')}>
            {lineData.length ? (
              <Line
                data={lineData}
                xField="date"
                yField="tokens"
                shapeField="smooth"
                autoFit
                height={chartHeight}
                theme={chartTheme}
                axis={{ y: { title: t('tokenUsage.totalTokens') } }}
                style={{ lineWidth: 2.5 }}
              />
            ) : (
              <div style={{ height: chartHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
                {t('tokenUsage.noChartData')}
              </div>
            )}
          </Card>
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
