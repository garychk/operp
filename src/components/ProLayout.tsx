import { useState, useEffect, useCallback } from 'react';
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
  InfoCircleFilled,
  QuestionCircleFilled,
  GithubFilled,
  PicLeftOutlined,
  PicCenterOutlined,
} from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import heroLogo from '../assets/favicon.svg';
import defaultAvatar from '../assets/avatar.png';

interface TabItem {
  key: string;
  label: string;
  closable: boolean;
  path: string;
}

const menuData = [
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
  const [ismix, setMix] = useState(() => {
    const saved = localStorage.getItem('erp-layout-mix');
    return saved !== null ? JSON.parse(saved) : true;
  });

  useEffect(() => {
    localStorage.setItem('erp-dark-mode', JSON.stringify(dark));
  }, [dark]);

  useEffect(() => {
    localStorage.setItem('erp-layout-mix', JSON.stringify(ismix));
  }, [ismix]);

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
    <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <AntProLayout
        layout={ismix ? 'mix' : 'side'}
        fixSiderbar
        fixedHeader
        splitMenus={false}
        title="Supabase ERP"
        logo={<img src={heroLogo} alt="Logo" style={{ height: '20px' }} />}
        route={{ routes: menuData }}
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
         <InfoCircleFilled key="info" hidden={!ismix} />,
          <QuestionCircleFilled key="question" />,
          <GithubFilled key="github" onClick={() => window.open('https://gitee.com/garychk/supabase-erp', '_blank')}  hidden={!ismix}/>
        ]}
        footerRender={() => (
          <div style={{ textAlign: 'center', padding: 12, color: '#999' }}>
            © 2026 Supabase ERP
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
      </AntProLayout>
    </ConfigProvider>
  );
}
