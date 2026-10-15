import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  List,
  Row,
  Skeleton,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ApartmentOutlined,
  AuditOutlined,
  BarChartOutlined,
  ClockCircleOutlined,
  ContainerOutlined,
  DatabaseOutlined,
  InboxOutlined,
  ReloadOutlined,
  RightOutlined,
  RiseOutlined,
  ScheduleOutlined,
  ShoppingCartOutlined,
  TeamOutlined,
  ToolOutlined,
  BellOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { supabase } from '../utils/supabase';
import { useAuth } from '../contexts/AuthContext';
import { formatShanghaiDateTime } from '../utils/datetime';
import { notificationTypeLabelKey, type NotificationRow } from '../components/NotificationBell';
import { useCurrencyRegistry } from '../utils/money';
import defaultAvatar from '../assets/avatar.png';

/**
 * 个人工作台（/workbench）
 *
 * 与业务菜单页的区别：这是「人的页面」而不是「单据的页面」，因此不进入 sys_menus，
 * 也不参与基线-副本的菜单授权（见 deploy_50 的双层授权模型）——
 * 任何登录用户都能打开，入口挂在头像下拉里，并且默认在新浏览器 Tab 中打开。
 *
 * 统计口径全部走 RLS：查询只按 is_deleted='n' 过滤，租户隔离由策略保证，
 * 前端不自行拼 tenant_id，避免和服务端的隔离规则出现两套口径。
 */

// ---------------------------------------------------------------------------
// 角色 → 统计可见性
//
// 角色的权威定义在 sys_roles.role_code（deploy_01 播种：super_admin / finance_manager /
// inventory_manager / mrp_manager / operator，deploy_50 追加 tenant_admin）。
// 这里按「关键词」而不是「精确 code」判定，是因为租户可以自建角色（如 finance_staff、
// warehouse_leader），精确匹配会让自建角色什么都看不到。
// ---------------------------------------------------------------------------
type RoleGroup = 'admin' | 'finance' | 'warehouse' | 'production';

const ADMIN_ROLE_CODES = ['super_admin', 'tenant_admin', 'admin', 'sys_admin'];

const ROLE_GROUP_KEYWORDS: Record<Exclude<RoleGroup, 'admin'>, string[]> = {
  finance: ['finance', 'financial', 'account'],
  warehouse: ['inventory', 'warehouse', 'stock', 'store'],
  production: ['mrp', 'production', 'manufactur'],
};

function resolveRoleGroups(roleCodes: string[], isSuperAdmin: boolean): Set<RoleGroup> {
  const groups = new Set<RoleGroup>();
  if (isSuperAdmin) groups.add('admin');
  roleCodes.forEach((code) => {
    const normalized = code.toLowerCase();
    if (ADMIN_ROLE_CODES.includes(normalized)) {
      groups.add('admin');
    }
    (Object.keys(ROLE_GROUP_KEYWORDS) as Array<Exclude<RoleGroup, 'admin'>>).forEach((group) => {
      if (ROLE_GROUP_KEYWORDS[group].some((keyword) => normalized.includes(keyword))) {
        groups.add(group);
      }
    });
  });
  return groups;
}

// 管理员看全部；基础统计（物料/客户/订单数）对所有角色开放
type StatScope = RoleGroup[] | 'all';

function isScopeVisible(scope: StatScope, groups: Set<RoleGroup>): boolean {
  if (scope === 'all') return true;
  if (groups.has('admin')) return true;
  return scope.some((group) => groups.has(group));
}

interface WorkbenchStats {
  materialCount: number;
  customerCount: number;
  warehouseCount: number;
  salesOrderCount: number;
  salesAmount: number;
  salesPendingCount: number;
  purchaseOrderCount: number;
  purchasePendingCount: number;
  inventoryQuantity: number;
  inventoryValue: number;
  productionOrderCount: number;
  productionOpenCount: number;
  plannedOutput: number;
  completedOutput: number;
  materialIssuePendingCount: number;
}

const EMPTY_STATS: WorkbenchStats = {
  materialCount: 0,
  customerCount: 0,
  warehouseCount: 0,
  salesOrderCount: 0,
  salesAmount: 0,
  salesPendingCount: 0,
  purchaseOrderCount: 0,
  purchasePendingCount: 0,
  inventoryQuantity: 0,
  inventoryValue: 0,
  productionOrderCount: 0,
  productionOpenCount: 0,
  plannedOutput: 0,
  completedOutput: 0,
  materialIssuePendingCount: 0,
};

interface StatCardConfig {
  key: keyof WorkbenchStats;
  labelKey: string;
  icon: ReactNode;
  scope: StatScope;
  precision?: number;
  currency?: boolean;
  path?: string;
}

const STAT_CARDS: StatCardConfig[] = [
  {
    key: 'materialCount',
    labelKey: 'workbench.stats.materialCount',
    icon: <InboxOutlined />,
    scope: 'all',
    path: '/inventory/products',
  },
  {
    key: 'customerCount',
    labelKey: 'workbench.stats.customerCount',
    icon: <TeamOutlined />,
    scope: 'all',
    path: '/inventory/customers',
  },
  {
    key: 'salesOrderCount',
    labelKey: 'workbench.stats.salesOrderCount',
    icon: <RiseOutlined />,
    scope: 'all',
    path: '/inventory/sales',
  },
  {
    key: 'warehouseCount',
    labelKey: 'workbench.stats.warehouseCount',
    icon: <ContainerOutlined />,
    scope: ['warehouse'],
    path: '/inventory/warehouses',
  },
  {
    key: 'inventoryQuantity',
    labelKey: 'workbench.stats.inventoryQuantity',
    icon: <DatabaseOutlined />,
    scope: ['warehouse', 'production'],
    path: '/inventory/stock',
  },
  {
    key: 'inventoryValue',
    labelKey: 'workbench.stats.inventoryValue',
    icon: <BarChartOutlined />,
    scope: ['finance'],
    currency: true,
    precision: 2,
    path: '/inventory/stock',
  },
  {
    key: 'salesAmount',
    labelKey: 'workbench.stats.salesAmount',
    icon: <RiseOutlined />,
    scope: ['finance'],
    currency: true,
    precision: 2,
    path: '/inventory/sales',
  },
  {
    key: 'purchaseOrderCount',
    labelKey: 'workbench.stats.purchaseOrderCount',
    icon: <ShoppingCartOutlined />,
    scope: ['warehouse', 'finance'],
    path: '/inventory/purchase',
  },
  {
    key: 'productionOrderCount',
    labelKey: 'workbench.stats.productionOrderCount',
    icon: <ToolOutlined />,
    scope: ['production'],
    path: '/mrp/production',
  },
  {
    key: 'completedOutput',
    labelKey: 'workbench.stats.completedOutput',
    icon: <ScheduleOutlined />,
    scope: ['production'],
    precision: 2,
    path: '/mrp/production',
  },
  {
    key: 'plannedOutput',
    labelKey: 'workbench.stats.plannedOutput',
    icon: <ClockCircleOutlined />,
    scope: ['production'],
    precision: 2,
    path: '/mrp/production',
  },
];

interface TodoConfig {
  key: string;
  labelKey: string;
  scope: StatScope;
  path: string;
  icon: ReactNode;
  /** 该待办对应 WorkbenchStats 里的计数字段；缺省时用 notificationCount */
  statKey?: keyof WorkbenchStats;
}

const TODO_ITEMS: TodoConfig[] = [
  {
    key: 'approval',
    labelKey: 'workbench.todo.approval',
    scope: 'all',
    path: '/',
    icon: <AuditOutlined />,
  },
  {
    key: 'salesOrder',
    labelKey: 'workbench.todo.salesOrder',
    scope: 'all',
    path: '/inventory/sales',
    statKey: 'salesPendingCount',
    icon: <RiseOutlined />,
  },
  {
    key: 'purchaseOrder',
    labelKey: 'workbench.todo.purchaseOrder',
    scope: ['warehouse', 'finance'],
    path: '/inventory/purchase',
    statKey: 'purchasePendingCount',
    icon: <ShoppingCartOutlined />,
  },
  {
    key: 'productionOrder',
    labelKey: 'workbench.todo.productionOrder',
    scope: ['production'],
    path: '/mrp/production',
    statKey: 'productionOpenCount',
    icon: <ToolOutlined />,
  },
  {
    key: 'materialIssue',
    labelKey: 'workbench.todo.materialIssue',
    scope: ['production'],
    path: '/mrp/material-issues',
    statKey: 'materialIssuePendingCount',
    icon: <InboxOutlined />,
  },
];

const PENDING_ORDER_STATUSES = ['draft', 'pending'];
const OPEN_PRODUCTION_STATUSES = ['draft', 'planned', 'released', 'in_progress'];
const PENDING_MATERIAL_ISSUE_STATUSES = ['draft'];

/** 欢迎条右侧通知跑马灯同时可见的条数（每条 22px，视口 44px） */
const MARQUEE_VISIBLE_ROWS = 1;
/** 滚动一轮的时长（秒），条目越多转得越慢，保证可读 */
const MARQUEE_DURATION_SECONDS = 10;

const severityColorMap: Record<string, string> = {
  info: 'blue',
  warning: 'orange',
  critical: 'red',
};

interface TenantInfo {
  id: number;
  code: string;
  name: string;
  status: string | null;
  remark: string | null;
  created_at: string | null;
}

interface InventoryRow {
  quantity: number | null;
  total_cost: number | null;
}

interface SalesOrderRow {
  status: string | null;
  total_amount: number | null;
}

interface StatusRow {
  status: string | null;
}

interface ProductionOrderRow {
  status: string | null;
  planned_quantity: number | null;
  completed_quantity: number | null;
}

const sumBy = <T,>(rows: T[], pick: (row: T) => number | null | undefined): number =>
  rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);

export function Workbench() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  // 工作台统计卡片里的金额一律本位币，符号跟随币别主数据
  const { getMeta } = useCurrencyRegistry();
  const baseCurrencySymbol = getMeta().symbol;

  const language = i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN';
  const [stats, setStats] = useState<WorkbenchStats>(EMPTY_STATS);
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);

  const userId = user?.profile?.id ?? null;
  const tenantId = user?.tenantId ?? null;

  const roleGroups = useMemo(
    () => resolveRoleGroups((user?.roles ?? []).map((role) => role.role_code), Boolean(user?.isSuperAdmin)),
    [user],
  );

  const formatNumber = useCallback(
    (value: number, precision = 0) =>
      new Intl.NumberFormat(language, {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      }).format(Number.isFinite(value) ? value : 0),
    [language],
  );

  const loadStats = useCallback(async (): Promise<WorkbenchStats> => {
    const next: WorkbenchStats = { ...EMPTY_STATS };

    const [inventoryRes, salesRes, purchaseRes, productionRes, issueRes, productRes, customerRes, warehouseRes] =
      await Promise.all([
        supabase.from('erp_inventory_s_539dcf81_b').select('quantity, total_cost').eq('is_deleted', 'n'),
        supabase.from('erp_sales_orders_s_539dcf81_b').select('status, total_amount').eq('is_deleted', 'n'),
        supabase.from('erp_purchase_orders_s_539dcf81_b').select('status').eq('is_deleted', 'n'),
        supabase
          .from('erp_production_orders_s_539dcf81_b')
          .select('status, planned_quantity, completed_quantity')
          .eq('is_deleted', 'n'),
        supabase.from('erp_material_issues_s_539dcf81_b').select('status').eq('is_deleted', 'n'),
        supabase.from('erp_products_s_539dcf81_b').select('id', { count: 'exact', head: true }).eq('is_deleted', 'n'),
        supabase.from('erp_customers_s_539dcf81_b').select('id', { count: 'exact', head: true }).eq('is_deleted', 'n'),
        supabase
          .from('erp_warehouses_s_539dcf81_b')
          .select('id', { count: 'exact', head: true })
          .eq('is_deleted', 'n'),
      ]);

    if (inventoryRes.error) {
      console.error('Workbench: failed to load inventory stats', inventoryRes.error);
    } else {
      const rows = (inventoryRes.data ?? []) as InventoryRow[];
      next.inventoryQuantity = sumBy(rows, (row) => row.quantity);
      next.inventoryValue = sumBy(rows, (row) => row.total_cost);
    }

    if (salesRes.error) {
      console.error('Workbench: failed to load sales order stats', salesRes.error);
    } else {
      const rows = (salesRes.data ?? []) as SalesOrderRow[];
      next.salesOrderCount = rows.length;
      next.salesAmount = sumBy(rows, (row) => row.total_amount);
      next.salesPendingCount = rows.filter((row) =>
        PENDING_ORDER_STATUSES.includes(row.status ?? ''),
      ).length;
    }

    if (purchaseRes.error) {
      console.error('Workbench: failed to load purchase order stats', purchaseRes.error);
    } else {
      const rows = (purchaseRes.data ?? []) as StatusRow[];
      next.purchaseOrderCount = rows.length;
      next.purchasePendingCount = rows.filter((row) =>
        PENDING_ORDER_STATUSES.includes(row.status ?? ''),
      ).length;
    }

    if (productionRes.error) {
      console.error('Workbench: failed to load production stats', productionRes.error);
    } else {
      const rows = (productionRes.data ?? []) as ProductionOrderRow[];
      next.productionOrderCount = rows.length;
      next.productionOpenCount = rows.filter((row) =>
        OPEN_PRODUCTION_STATUSES.includes(row.status ?? ''),
      ).length;
      next.plannedOutput = sumBy(rows, (row) => row.planned_quantity);
      next.completedOutput = sumBy(rows, (row) => row.completed_quantity);
    }

    if (issueRes.error) {
      console.error('Workbench: failed to load material issue stats', issueRes.error);
    } else {
      const rows = (issueRes.data ?? []) as StatusRow[];
      next.materialIssuePendingCount = rows.filter((row) =>
        PENDING_MATERIAL_ISSUE_STATUSES.includes(row.status ?? ''),
      ).length;
    }

    if (!productRes.error) next.materialCount = productRes.count ?? 0;
    if (!customerRes.error) next.customerCount = customerRes.count ?? 0;
    if (!warehouseRes.error) next.warehouseCount = warehouseRes.count ?? 0;

    return next;
  }, []);

  const loadNotifications = useCallback(async (): Promise<NotificationRow[]> => {
    if (!userId) return [];
    const { data, error } = await supabase
      .from('sys_notifications')
      .select('*')
      .eq('is_deleted', 'n')
      .eq('recipient_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      console.error('Workbench: failed to load notifications', error);
      return [];
    }
    return (data ?? []) as NotificationRow[];
  }, [userId]);

  const loadTenant = useCallback(async (): Promise<TenantInfo | null> => {
    if (tenantId === null) return null;
    const { data, error } = await supabase
      .from('sys_tenants')
      .select('id, code, name, status, remark, created_at')
      .eq('id', tenantId)
      .maybeSingle();

    if (error) {
      console.error('Workbench: failed to load tenant info', error);
      return null;
    }
    return (data as TenantInfo | null) ?? null;
  }, [tenantId]);

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [statsResult, notificationsResult, tenantResult] = await Promise.all([
        loadStats(),
        loadNotifications(),
        loadTenant(),
      ]);
      setStats(statsResult);
      setNotifications(notificationsResult);
      setTenant(tenantResult);
    } catch (error) {
      console.error('Workbench: failed to load workbench data', error);
      message.error(t('workbench.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [user, loadStats, loadNotifications, loadTenant, t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const unreadNotifications = notifications.filter((row) => !row.is_read);
  const pendingApprovalCount = unreadNotifications.filter(
    (row) => row.notification_type === 'approval_pending',
  ).length;

  const visibleStats = useMemo(
    () => STAT_CARDS.filter((card) => isScopeVisible(card.scope, roleGroups)),
    [roleGroups],
  );

  const visibleTodos = useMemo(() => {
    const items = TODO_ITEMS.filter((item) => isScopeVisible(item.scope, roleGroups)).map((item) => ({
      ...item,
      count: item.statKey ? stats[item.statKey] : pendingApprovalCount,
    }));
    // 计数为 0 的待办保留展示（用户需要知道「现在没有待办」），但排在后面
    return items.sort((a, b) => Number(b.count > 0) - Number(a.count > 0));
  }, [roleGroups, stats, pendingApprovalCount]);

  const markNotificationRead = useCallback(async (row: NotificationRow) => {
    if (!row.is_read) {
      const { error } = await supabase
        .from('sys_notifications')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('id', row.id);
      if (error) {
        console.error('Workbench: failed to mark notification read', error);
      } else {
        setNotifications((prev) =>
          prev.map((item) => (item.id === row.id ? { ...item, is_read: true, read_at: new Date().toISOString() } : item)),
        );
      }
    }
    if (row.link_path) {
      navigate(row.link_path);
    }
  }, [navigate]);

  const notificationMarqueeItems =
    notifications.length > MARQUEE_VISIBLE_ROWS ? [...notifications, ...notifications] : notifications;
  const marqueeAnimationPaused = notifications.length <= MARQUEE_VISIBLE_ROWS;

  const roleScopeHint = useMemo(() => {
    if (roleGroups.has('admin')) return 'workbench.stats.roleHint.admin';
    if (roleGroups.has('finance')) return 'workbench.stats.roleHint.finance';
    if (roleGroups.has('warehouse')) return 'workbench.stats.roleHint.warehouse';
    if (roleGroups.has('production')) return 'workbench.stats.roleHint.production';
    return 'workbench.stats.roleHint.default';
  }, [roleGroups]);

  const displayName = user?.profile.real_name || user?.profile.username || user?.auth.email || '';
  const tenantStatusEnabled = tenant?.status === '1';
  const accountEnabled = user?.profile.status === '1';

  return (
    <Card
      variant="borderless"
      title={t('workbench.title')}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void loadAll()} loading={loading}>
          {t('common.refresh')}
        </Button>
      }
    >
      <Card variant="borderless" className="workbench-hero" style={{ marginBottom: 16 }}>
        {/* 与登录页同一套色斑，只是静态摆放（见 index.css 的 .workbench-hero*） */}
        <div className="workbench-hero__blob workbench-hero__blob--sky" aria-hidden="true" />
        <div className="workbench-hero__blob workbench-hero__blob--violet" aria-hidden="true" />
        <div className="workbench-hero__blob workbench-hero__blob--mint" aria-hidden="true" />
        <div className="workbench-hero__content">
          <Row gutter={16} align="middle" wrap>
            <Col flex="none">
              <Avatar size={56} src={user?.profile.avatar_url || defaultAvatar} />
            </Col>
            <Col flex="auto">
              <Typography.Title level={4} style={{ margin: 0 }}>
                {t('workbench.welcome', { name: displayName })}
              </Typography.Title>
              <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(user?.roles ?? []).map((role) => (
                  <Tag key={role.id} color="blue">
                    {role.role_name}
                  </Tag>
                ))}
                {tenant ? <Tag icon={<ApartmentOutlined />}>{tenant.name}</Tag> : null}
                <Tag color={unreadNotifications.length > 0 ? 'orange' : 'default'}>
                  {t('workbench.notification.unreadCount', { count: unreadNotifications.length })}
                </Tag>
              </div>
            </Col>
            <Col flex="none" style={{ minWidth: 0 }}>
              <div
                className="workbench-hero__marquee"
                style={{ width: 420, maxWidth: '100%' }}
                title={t('notification.title')}
              >
                <span className="workbench-hero__marquee-badge">
                  <BellOutlined />
                  <Badge count={unreadNotifications.length} size="small" />
                </span>
                {notifications.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('notification.empty')}
                  </Typography.Text>
                ) : (
                  <div className="workbench-hero__marquee-viewport">
                    <div
                      className="workbench-hero__marquee-track"
                      style={{
                        animationDuration: `${MARQUEE_DURATION_SECONDS}s`,
                        animationPlayState: marqueeAnimationPaused ? 'paused' : 'running',
                      }}
                    >
                      {notificationMarqueeItems.map((row, index) => (
                        <div
                          className="workbench-hero__marquee-item"
                          key={`${row.id}-${index}`}
                          title={`${row.title} · ${row.content}`}
                          onClick={() => void markNotificationRead(row)}
                        >
                          {!row.is_read ? <Badge status="processing" /> : null}
                          <span
                            className="workbench-hero__marquee-text"
                            style={{ fontWeight: row.is_read ? 400 : 600 }}
                          >
                            {row.title}
                          </span>
                          <Tag
                            color={severityColorMap[row.severity] ?? 'default'}
                            style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', padding: '0 6px' }}
                          >
                            {t(notificationTypeLabelKey(row.notification_type))}
                          </Tag>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Col>
          </Row>
        </div>
      </Card>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={8}>
          <Card
            variant="borderless"
            size="small"
            title={t('workbench.basicInfo')}
            style={{ height: '100%' }}
          >
            <Skeleton loading={loading} active paragraph={{ rows: 5 }}>
              <Descriptions column={1} size="small" styles={{ label: { width: 96 } }}>
                <Descriptions.Item label={t('workbench.fields.username')}>
                  {user?.profile.username || '-'}
                </Descriptions.Item>
                <Descriptions.Item label={t('workbench.fields.realName')}>
                  {user?.profile.real_name || '-'}
                </Descriptions.Item>
                <Descriptions.Item label={t('workbench.fields.roles')}>
                  {user?.roles.length
                    ? user.roles.map((role) => role.role_name).join(' / ')
                    : t('workbench.fields.unassigned')}
                </Descriptions.Item>
                <Descriptions.Item label={t('workbench.fields.phone')}>
                  {user?.profile.phone || '-'}
                </Descriptions.Item>
                <Descriptions.Item label={t('workbench.fields.email')}>
                  {user?.profile.email || '-'}
                </Descriptions.Item>
                <Descriptions.Item label={t('workbench.fields.accountStatus')}>
                  <Tag color={accountEnabled ? 'success' : 'error'}>
                    {accountEnabled ? t('common.enabled') : t('common.disabled')}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label={t('workbench.fields.lastLogin')}>
                  {/* 权威值是 Supabase 会话里的 last_sign_in_at；
                      sys_users.last_login_at 目前没有任何写入路径（见 Users 页同样恒为「-」），只作兜底 */}
                  {formatShanghaiDateTime(user?.auth.last_sign_in_at || user?.profile.last_login_at)}
                </Descriptions.Item>
                <Descriptions.Item label={t('workbench.fields.createdAt')}>
                  {formatShanghaiDateTime(user?.profile.created_at)}
                </Descriptions.Item>
              </Descriptions>
            </Skeleton>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            variant="borderless"
            size="small"
            title={t('workbench.tenantInfo')}
            style={{ height: '100%' }}
          >
            <Skeleton loading={loading} active paragraph={{ rows: 5 }}>
              {tenant ? (
                <Descriptions column={1} size="small" styles={{ label: { width: 96 } }}>
                  <Descriptions.Item label={t('workbench.fields.tenantCode')}>
                    {tenant.code}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('workbench.fields.tenantName')}>
                    {tenant.name}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('workbench.fields.tenantStatus')}>
                    <Tag color={tenantStatusEnabled ? 'success' : 'error'}>
                      {tenantStatusEnabled ? t('common.enabled') : t('common.disabled')}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label={t('workbench.fields.tenantCreatedAt')}>
                    {formatShanghaiDateTime(tenant.created_at)}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('workbench.fields.tenantRemark')}>
                    {tenant.remark || '-'}
                  </Descriptions.Item>
                </Descriptions>
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('workbench.tenantUnassigned')}
                />
              )}
            </Skeleton>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            variant="borderless"
            size="small"
            title={
              <span>
                <BellOutlined style={{ marginRight: 8 }} />
                {t('workbench.todo.title')}
              </span>
            }
            style={{ height: '100%' }}
          >
            <Skeleton loading={loading} active paragraph={{ rows: 5 }}>
              <List
                size="small"
                dataSource={visibleTodos}
                rowKey={(item) => item.key}
                renderItem={(item) => (
                  <List.Item
                    style={{ cursor: 'pointer', padding: '8px 4px' }}
                    onClick={() => navigate(item.path)}
                  >
                    <List.Item.Meta
                      avatar={<span style={{ fontSize: 16 }}>{item.icon}</span>}
                      title={
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ flex: 1 }}>{t(item.labelKey)}</span>
                          <Tag
                            color={item.count > 0 ? 'orange' : 'default'}
                            style={{ marginInlineEnd: 0 }}
                          >
                            {formatNumber(item.count)}
                          </Tag>
                          <RightOutlined style={{ fontSize: 10, opacity: 0.45 }} />
                        </span>
                      }
                    />
                  </List.Item>
                )}
              />
            </Skeleton>
          </Card>
        </Col>
      </Row>

      <Card
        variant="borderless"
        size="small"
        title={t('workbench.stats.title')}
        extra={
          <Tooltip title={t(roleScopeHint)}>
            <Tag color="blue">{t('workbench.stats.scopeTag')}</Tag>
          </Tooltip>
        }
        style={{ marginBottom: 16 }}
      >
        <Skeleton loading={loading} active paragraph={{ rows: 3 }}>
          <Row gutter={[16, 16]}>
            {visibleStats.map((card) => (
              <Col xs={12} sm={8} lg={6} xxl={4} key={card.key}>
                <Card
                  variant="borderless"
                  size="small"
                  hoverable={Boolean(card.path)}
                  onClick={() => (card.path ? navigate(card.path) : undefined)}
                  style={{ cursor: card.path ? 'pointer' : 'default' }}
                >
                  <Statistic
                    title={
                      <span>
                        <span style={{ marginRight: 6, opacity: 0.75 }}>{card.icon}</span>
                        {t(card.labelKey)}
                      </span>
                    }
                    value={stats[card.key]}
                    prefix={card.currency ? baseCurrencySymbol : undefined}
                    formatter={(value) => formatNumber(Number(value), card.precision ?? 0)}
                    valueStyle={{ fontSize: 20 }}
                  />
                </Card>
              </Col>
            ))}
          </Row>
        </Skeleton>
      </Card>
    </Card>
  );
}

export default Workbench;
