import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { ProLayout as AntProLayout, PageContainer, ProCard } from '@ant-design/pro-components';
import { Tabs, Button, Dropdown, Tag, ConfigProvider, theme } from 'antd';
import {
  DashboardOutlined,
  BookOutlined,
  ShoppingOutlined,
  ToolOutlined,
  TeamOutlined,
  ShopOutlined,
  InboxOutlined,
  AppstoreOutlined,
  ShoppingCartOutlined,
  RiseOutlined,
  FallOutlined,
  SettingOutlined,
  BuildOutlined,
  BranchesOutlined,
  ProfileOutlined,
  CalendarOutlined,
  ContainerOutlined,
  SafetyOutlined,
  MenuOutlined,
  FileTextOutlined,
  LogoutOutlined,
  TruckOutlined,
  SunFilled,
  MoonOutlined,
  BgColorsOutlined,
  CheckOutlined,
  InfoCircleFilled,
  GithubFilled,
  PicLeftOutlined,
  PicCenterOutlined,
  OpenAIOutlined,
} from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import { AIChatDrawer } from './AIChatDrawer';
import heroLogo from '../assets/opelix.svg';
import defaultAvatar from '../assets/avatar.png';

interface TabItem {
  key: string;
  label: string;
  closable: boolean;
  path: string;
}

interface MenuRoute {
  path: string;
  name: string;
  icon: React.ReactNode;
  routes?: MenuRoute[];
}

type ThemeColorKey = 'default' | 'blue' | 'green' | 'orange' | 'purple' | 'warmPaper';

interface ThemeColor {
  label: string;
  color: string;
  rgb: string;
  secondaryRgb?: string;
  surfaceColor?: string;
  surfaceRgb?: string;
}

const themeColors: Record<ThemeColorKey, ThemeColor> = {
  default: { label: '默认', color: '#1677ff', rgb: '22, 119, 255' },
  blue: { label: '星际蓝', color: '#0ea5e9', rgb: '14, 165, 233', secondaryRgb: '99, 102, 241', surfaceRgb: '47, 134, 237' },
  green: { label: '极光绿', color: '#10b981', rgb: '16, 185, 129', secondaryRgb: '6, 182, 212', surfaceRgb: '11, 184, 171' },
  orange: { label: '脉冲橙', color: '#f97316', rgb: '249, 115, 22', secondaryRgb: '225, 29, 72', surfaceRgb: '237, 72, 47' },
  purple: { label: '星云紫', color: '#8b5cf6', rgb: '139, 92, 246', secondaryRgb: '6, 182, 212', surfaceRgb: '73, 137, 229' },
  warmPaper: {
    label: '暖纸色', color: '#9c5f36', rgb: '156, 95, 54',
    surfaceColor: '#f0eee6', surfaceRgb: '240, 238, 230',
  },
};

const themeSurface = (themeColor: ThemeColorKey, dark: boolean, opacity: number, base = false) => {
  const selected = themeColors[themeColor];
  if (base && selected.surfaceColor && !dark) return selected.surfaceColor;
  const rgb = base ? selected.surfaceRgb ?? selected.rgb : selected.rgb;
  return `rgba(${rgb}, ${dark ? opacity * 1.8 : opacity})`;
};

const themeHeaderBackground = (themeColor: ThemeColorKey, dark: boolean) => {
  const selected = themeColors[themeColor];
  if (selected.surfaceColor && !dark) {
    return 'linear-gradient(115deg, #f0eee6 0%, #f5f2eb 55%, #efebe2 100%)';
  }

  const primaryOpacity = dark ? 0.11 : 0.055;
  const secondaryOpacity = dark ? 0.07 : 0.028;
  const secondaryRgb = selected.secondaryRgb ?? selected.rgb;
  return `linear-gradient(115deg, rgba(${selected.rgb}, ${primaryOpacity}) 0%, rgba(${secondaryRgb}, ${secondaryOpacity}) 55%, rgba(${selected.rgb}, ${primaryOpacity * 0.65}) 100%)`;
};


const menuData: MenuRoute[] = [
  {
    path: '/',
    name: '首页',
    icon: <DashboardOutlined />,
  },
  {
    path: '/finance',
    name: '财务管理',
    icon: <BookOutlined />,
    routes: [
      { path: '/finance/subjects', name: '会计科目', icon: <ContainerOutlined /> },
      { path: '/finance/vouchers', name: '凭证管理', icon: <ProfileOutlined /> },
      { path: '/finance/receivables', name: '应收账款', icon: <RiseOutlined /> },
      { path: '/finance/payables', name: '应付账款', icon: <FallOutlined /> },
      { path: '/finance/assets', name: '固定资产', icon: <BuildOutlined /> },
      { path: '/finance/asset-categories', name: '资产类别', icon: <ContainerOutlined /> },
    ],
  },
  {
    path: '/inventory',
    name: '进销存管理',
    icon: <ShoppingOutlined />,
    routes: [
      { path: '/inventory/customers', name: '客户管理', icon: <TeamOutlined /> },
      { path: '/inventory/suppliers', name: '供应商管理', icon: <ShopOutlined /> },
      { path: '/inventory/products', name: '物料管理', icon: <InboxOutlined /> },
      { path: '/inventory/warehouses', name: '仓库管理', icon: <AppstoreOutlined /> },
      { path: '/inventory/stock', name: '库存查询', icon: <ShoppingOutlined /> },
      { path: '/inventory/purchase', name: '采购订单', icon: <ShoppingCartOutlined /> },
      { path: '/inventory/purchase-receipts', name: '采购入库', icon: <InboxOutlined /> },
      { path: '/inventory/sales', name: '销售订单', icon: <RiseOutlined /> },
      { path: '/inventory/sales-deliveries', name: '销售出货', icon: <TruckOutlined /> },
    ],
  },
  {
    path: '/mrp',
    name: '生产制造',
    icon: <ToolOutlined />,
    routes: [
      { path: '/mrp/departments', name: '部门管理', icon: <TeamOutlined /> },
      { path: '/mrp/boms', name: 'BOM管理', icon: <BranchesOutlined /> },
      { path: '/mrp/routings', name: '工艺路线', icon: <SettingOutlined /> },
      { path: '/mrp/workcenters', name: '工作中心', icon: <ToolOutlined /> },
      { path: '/mrp/operations', name: '工序管理', icon: <SettingOutlined /> },
      { path: '/mrp/production', name: '生产订单', icon: <ProfileOutlined /> },
      { path: '/mrp/plans', name: 'MRP计划', icon: <CalendarOutlined /> },
    ],
  },
  {
    path: '/system',
    name: '系统管理',
    icon: <SettingOutlined />,
    routes: [
      { path: '/system/users', name: '用户管理', icon: <TeamOutlined /> },
      { path: '/system/roles', name: '角色管理', icon: <SafetyOutlined /> },
      { path: '/system/menus', name: '菜单管理', icon: <MenuOutlined /> },
      { path: '/system/settings', name: '系统设置', icon: <SettingOutlined /> },
      { path: '/system/logs', name: '系统日志', icon: <FileTextOutlined /> },
    ],
  },
];

const pathToNameMap: Record<string, string> = {
  '/': '首页',
  '/finance/subjects': '会计科目',
  '/finance/vouchers': '凭证管理',
  '/finance/receivables': '应收账款',
  '/finance/payables': '应付账款',
  '/finance/assets': '固定资产',
  '/finance/asset-categories': '资产类别',
  '/inventory/customers': '客户管理',
  '/inventory/suppliers': '供应商管理',
  '/inventory/products': '物料管理',
  '/inventory/warehouses': '仓库管理',
  '/inventory/stock': '库存查询',
  '/inventory/purchase': '采购订单',
  '/inventory/purchase-receipts': '采购入库',
  '/inventory/sales': '销售订单',
  '/inventory/sales-deliveries': '销售出货',
  '/mrp/departments': '部门管理',
  '/mrp/boms': 'BOM管理',
  '/mrp/routings': '工艺路线',
  '/mrp/workcenters': '工作中心',
  '/mrp/operations': '工序管理',
  '/mrp/production': '生产订单',
  '/mrp/plans': 'MRP计划',
  '/system/users': '用户管理',
  '/system/roles': '角色管理',
  '/system/menus': '菜单管理',
  '/system/settings': '系统设置',
  '/system/logs': '系统日志',
};

export function ProLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [tabs, setTabs] = useState<TabItem[]>([
    { key: '/', label: '首页', closable: false, path: '/' },
  ]);
  const [activeTabKey, setActiveTabKey] = useState('/');
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('erp-dark-mode');
    return saved !== null ? JSON.parse(saved) : false;
  });
  const [themeColor, setThemeColor] = useState<ThemeColorKey>(() => {
    const saved = localStorage.getItem('erp-theme-color');
    return saved && saved in themeColors ? saved as ThemeColorKey : 'default';
  });
  const [ismix, setMix] = useState(() => {
    const saved = localStorage.getItem('erp-layout-mix');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [aiChatOpen, setAiChatOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem('erp-dark-mode', JSON.stringify(dark));
  }, [dark]);

  useEffect(() => {
    const selected = themeColors[themeColor];
    localStorage.setItem('erp-theme-color', themeColor);
    document.documentElement.style.setProperty('--accent', selected.color);
    document.documentElement.style.setProperty('--accent-bg', `rgba(${selected.rgb}, 0.1)`);
    document.documentElement.style.setProperty('--accent-border', `rgba(${selected.rgb}, 0.5)`);
  }, [themeColor]);

  useEffect(() => {
    localStorage.setItem('erp-layout-mix', JSON.stringify(ismix));

  }, [ismix]);

  const visibleMenuData = useMemo(() => {
    if (!user || user.isSuperAdmin) {
      return menuData;
    }

    if (user.menuPaths.length === 0) {
      return menuData;
    }

    const allowedPaths = new Set(user.menuPaths);

    const filterRoutes = (routes: MenuRoute[]): MenuRoute[] => {
      const result: MenuRoute[] = [];

      routes.forEach((route) => {
        const children = route.routes ? filterRoutes(route.routes) : undefined;
        const visibleByPath = route.path === '/' || allowedPaths.has(route.path);
        const visibleByChildren = Boolean(children?.length);

        if (!visibleByPath && !visibleByChildren) {
          return;
        }

        result.push({
          ...route,
          routes: children,
        });
      });

      return result;
    };

    return filterRoutes(menuData);
  }, [user]);

  const handleLogout = async () => {
    await logout();
  };

  const addTab = useCallback((path: string) => {
    const label = pathToNameMap[path] || '未命名';
    setTabs((prev) => {
      const existingTab = prev.find((tab) => tab.key === path);
      if (!existingTab) {
        return [...prev, { key: path, label, closable: true, path }];
      }
      return prev;
    });
    setActiveTabKey(path);
  }, []);

  const removeTab = useCallback((targetKey: string) => {
    let newActiveKey = activeTabKey;
    let lastIndex = -1;
    tabs.forEach((tab, i) => {
      if (tab.key === targetKey) {
        lastIndex = i - 1;
      }
    });
    const newTabs = tabs.filter((tab) => tab.key !== targetKey);
    if (newTabs.length && newActiveKey === targetKey) {
      if (lastIndex >= 0) {
        newActiveKey = newTabs[lastIndex].key;
      } else {
        newActiveKey = newTabs[0].key;
      }
    }
    setTabs(newTabs);
    setActiveTabKey(newActiveKey);
    navigate(newActiveKey);
  }, [tabs, activeTabKey, navigate]);

  const handleTabChange = useCallback((key: string) => {
    setActiveTabKey(key);
    navigate(key);
  }, [navigate]);

  useEffect(() => {
    const path = location.pathname;
    if (pathToNameMap[path]) {
      addTab(path);
    }
  }, [location.pathname, addTab]);

  const tabItems = tabs.map((tab) => ({
    key: tab.key,
    label: tab.label,
    closable: tab.closable,
  }));
  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: themeColors[themeColor].color },
      }}
    >
      <AntProLayout
        layout={ismix ? 'mix' : 'side'}
        className={themeColor === 'default' ? undefined : 'themed-pro-layout'}
        style={themeColor === 'default' ? undefined : {
          '--theme-header-background': themeHeaderBackground(themeColor, dark),
        } as React.CSSProperties}
        token={themeColor === 'default' ? undefined : {
          header: {
            colorBgHeader: themeSurface(themeColor, dark, 0.06, true),
            colorBgScrollHeader: themeSurface(themeColor, dark, 0.075, true),
            colorBgMenuItemHover: themeSurface(themeColor, dark, 0.06),
            colorBgMenuItemSelected: themeSurface(themeColor, dark, 0.1),
            colorBgRightActionsItemHover: themeSurface(themeColor, dark, 0.06),
          },
          sider: {
            colorMenuBackground: themeSurface(themeColor, dark, 0.015),
            colorBgMenuItemHover: themeSurface(themeColor, dark, 0.045),
            colorBgMenuItemActive: themeSurface(themeColor, dark, 0.065),
            colorBgMenuItemSelected: themeSurface(themeColor, dark, 0.09),
            colorBgCollapsedButton: themeSurface(themeColor, dark, 0.055),
          },
        }}
        fixSiderbar
        fixedHeader
        splitMenus={false}
        title="OPERP"
        logo={<img src={heroLogo} alt="Logo" style={{ height: '20px' }} />}
        route={{ routes: visibleMenuData }}
        location={{ pathname: location.pathname }}
        menuItemRender={(item, dom) => (
          <div onClick={() => navigate(item.path || '/')}>{dom}</div>
        )}
        headerContentRender={() => (
          <Tag color="gold">V1.0</Tag>
        )}
        avatarProps={{
          src: user?.profile.avatar_url || defaultAvatar,
          size: 'small',
          title: user?.profile.real_name || user?.profile.username || user?.auth.email || '',
          render: (_props, dom) => {
            return (
              user ?
                (<Dropdown
                  menu={{
                    items: [
                      {
                        key: 'logout',
                        icon: <LogoutOutlined />,
                        label: '退出登录',
                        onClick: handleLogout,
                      },
                    ],
                  }}
                >
                  {dom}
                </Dropdown>) : (
                  <Button
                    size='small'
                    type="primary"
                    onClick={() => {
                      if (typeof (window as any).AIApp !== 'undefined') {
                        (window as any).AIApp.Auth?.login();
                      } else {
                        window.location.href = '/login';
                      }
                    }}
                  >
                    登录
                  </Button>
                )
            );
          }
        }}
        actionsRender={() => [
          dark ? (            
            <MoonOutlined key="theme" onClick={() => setDark(false)} />
          ) : (
            <SunFilled key="theme" onClick={() => setDark(true)} />
          ),
          ismix ? (
            <PicLeftOutlined key="mix" onClick={() => setMix(false)} />
          ):(<PicCenterOutlined key="mix" onClick={() => setMix(true)} />),
          <Dropdown
            key="theme-color"
            trigger={['click']}
            menu={{
              selectable: true,
              selectedKeys: [themeColor],
              onClick: ({ key }) => setThemeColor(key as ThemeColorKey),
              items: Object.entries(themeColors).map(([key, item]) => ({
                key,
                label: (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 72 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 3,
                        background: item.secondaryRgb
                          ? `linear-gradient(135deg, ${item.color}, rgb(${item.secondaryRgb}))`
                          : item.surfaceColor ?? item.color,
                        border: item.surfaceColor ? '1px solid rgba(0, 0, 0, 0.12)' : undefined,
                      }}
                    />
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {themeColor === key ? <CheckOutlined /> : null}
                  </span>
                ),
              })),
            }}
          >
            <BgColorsOutlined
              title="切换主题色"
              aria-label="切换主题色"
              style={{ color: themeColors[themeColor].color }}
            />
          </Dropdown>,
         <InfoCircleFilled key="info" hidden={!ismix} />,
          <OpenAIOutlined
            key="openai"
            className={`ai-chat-action${aiChatOpen ? ' ai-chat-action-active' : ''}`}
            onClick={() => setAiChatOpen(true)}
          />,
          <GithubFilled key="github" onClick={() => window.open('https://gitee.com/garychk/supabase-erp', '_blank')}  hidden={!ismix}/>
        ]}
        footerRender={() => (
          <div style={{ textAlign: 'center', padding: 12, color: '#999' }}>
            © 2026 OPERP
          </div>
        )}
      >
        <PageContainer title={false} >
          <ProCard>
            <Tabs
              activeKey={activeTabKey}
              onChange={handleTabChange}
              type="editable-card"
              hideAdd
              items={tabItems}
              onEdit={(targetKey, action) => {
                if (action === 'remove') {
                  removeTab(targetKey as string);
                }
              }}
            />
            <Outlet />
          </ProCard>
        </PageContainer>
        <AIChatDrawer open={aiChatOpen} onClose={() => setAiChatOpen(false)} />
      </AntProLayout>
    </ConfigProvider>
  );
}
