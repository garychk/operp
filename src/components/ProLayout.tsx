import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { ProLayout as AntProLayout } from '@ant-design/pro-components';
import { Tabs, Avatar, Button, Dropdown } from 'antd';
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
  UserOutlined,
} from '@ant-design/icons';
import { supabase } from '../utils/supabase';
import { logOperation } from '../utils/logger';
import heroLogo from '../assets/favicon.svg';

interface TabItem {
  key: string;
  label: string;
  closable: boolean;
  path: string;
}

interface UserInfo {
  id: string;
  email: string;
  nick: string;
  avatar: string;
}

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
    children: [
      { path: '/finance/subjects', name: '会计科目', icon: <ContainerOutlined /> },
      { path: '/finance/vouchers', name: '凭证管理', icon: <ProfileOutlined /> },
      { path: '/finance/receivables', name: '应收账款', icon: <RiseOutlined /> },
      { path: '/finance/payables', name: '应付账款', icon: <FallOutlined /> },
      { path: '/finance/assets', name: '固定资产', icon: <BuildOutlined /> },
    ],
  },
  {
    path: '/inventory',
    name: '进销存管理',
    icon: <ShoppingOutlined />,
    children: [
      { path: '/inventory/customers', name: '客户管理', icon: <TeamOutlined /> },
      { path: '/inventory/suppliers', name: '供应商管理', icon: <ShopOutlined /> },
      { path: '/inventory/products', name: '物料管理', icon: <InboxOutlined /> },
      { path: '/inventory/warehouses', name: '仓库管理', icon: <AppstoreOutlined /> },
      { path: '/inventory/stock', name: '库存查询', icon: <ShoppingOutlined /> },
      { path: '/inventory/purchase', name: '采购订单', icon: <ShoppingCartOutlined /> },
      { path: '/inventory/sales', name: '销售订单', icon: <RiseOutlined /> },
    ],
  },
  {
    path: '/mrp',
    name: '生产制造',
    icon: <ToolOutlined />,
    children: [
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
    children: [
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
  '/inventory/customers': '客户管理',
  '/inventory/suppliers': '供应商管理',
  '/inventory/products': '物料管理',
  '/inventory/warehouses': '仓库管理',
  '/inventory/stock': '库存查询',
  '/inventory/purchase': '采购订单',
  '/inventory/sales': '销售订单',
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
  const [tabs, setTabs] = useState<TabItem[]>([
    { key: '/', label: '首页', closable: false, path: '/' },
  ]);
  const [activeTabKey, setActiveTabKey] = useState('/');
  const [user, setUser] = useState<UserInfo | null>(null);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        const userInfo = {
          id: session.user.id,
          email: session.user.email || '',
          nick: session.user.user_metadata?.nick || session.user.email || '',
          avatar: session.user.user_metadata?.avatar || '',
        };
        setUser(userInfo);
        await logOperation({
          operation: '用户登录',
          method: 'LOGIN',
          status: 'success',
        });
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
      }
    });

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser({
          id: session.user.id,
          email: session.user.email || '',
          nick: session.user.user_metadata?.nick || session.user.email || '',
          avatar: session.user.user_metadata?.avatar || '',
        });
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const addTab = useCallback((path: string) => {
    const label = pathToNameMap[path] || '未命名';
    const existingTab = tabs.find((tab) => tab.key === path);
    if (!existingTab) {
      setTabs((prev) => [...prev, { key: path, label, closable: true, path }]);
    }
    setActiveTabKey(path);
  }, [tabs]);

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
    <AntProLayout
      layout="mix"
      fixSiderbar
      fixedHeader
      splitMenus={false}
      title="Supabase ERP"
      logo={<img src={heroLogo} alt="Logo" style={{ height: '20px' }} />}
      menuDataRender={() => menuData}
      location={{ pathname: location.pathname }}
      menuItemRender={(item, dom) => (
        <div onClick={() => navigate(item.path || '/')}>{dom}</div>
      )}
      headerContentRender={() => (
        <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
          <span>V1.0</span>
        </div>
      )}
      rightContentRender={() => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {user ? (
            <Dropdown
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <Avatar src={user.avatar} icon={<UserOutlined />} size="small" />
                <span style={{ color: '#333' }}>{user.nick}</span>
              </div>
            </Dropdown>
          ) : (
            <Button
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
          )}
        </div>
      )}
      footerRender={() => (
        <div style={{ textAlign: 'center', padding: 16, color: '#999' }}>
          © 2024 ERP System
        </div>
      )}
    >
      <div style={{ background: '#f0f2f5', minHeight: 'calc(100vh - 112px)' }}>
        <div style={{ background: '#fff', padding: '0px' }}>
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
        </div>
        <div style={{ padding: 0, background: '#fff', minHeight: 'calc(100vh - 160px)' }}>
          <Outlet />
        </div>
      </div>
    </AntProLayout>
  );
}
