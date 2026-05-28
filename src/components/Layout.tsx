import { Outlet, Link, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, 
  BookOpen, 
  Package, 
  Factory, 
  ChevronDown,
  ChevronRight,
  Building2,
  Users,
  Boxes,
  Warehouse,
  ShoppingCart,
  TrendingUp,
  TrendingDown,
  Calculator,
  Settings,
  Cog,
  GitBranch,
  ClipboardList,
  CalendarDays
} from 'lucide-react';
import { useState } from 'react';

interface MenuItem {
  title: string;
  icon: React.ReactNode;
  path?: string;
  children?: MenuItem[];
}

const menuItems: MenuItem[] = [
  { title: '首页', icon: <LayoutDashboard size={20} />, path: '/' },
  {
    title: '财务管理',
    icon: <BookOpen size={20} />,
    path: '/finance',
    children: [
      { title: '会计科目', icon: <Calculator size={16} />, path: '/finance/subjects' },
      { title: '凭证管理', icon: <ClipboardList size={16} />, path: '/finance/vouchers' },
      { title: '应收账款', icon: <TrendingUp size={16} />, path: '/finance/receivables' },
      { title: '应付账款', icon: <TrendingDown size={16} />, path: '/finance/payables' },
      { title: '固定资产', icon: <Building2 size={16} />, path: '/finance/assets' },
      { title: '资产类别', icon: <Boxes size={16} />, path: '/finance/asset-categories' },
    ],
  },
  {
    title: '进销存管理',
    icon: <Package size={20} />,
    path: '/inventory',
    children: [
      { title: '客户管理', icon: <Users size={16} />, path: '/inventory/customers' },
      { title: '供应商管理', icon: <Building2 size={16} />, path: '/inventory/suppliers' },
      { title: '物料管理', icon: <Boxes size={16} />, path: '/inventory/products' },
      { title: '仓库管理', icon: <Warehouse size={16} />, path: '/inventory/warehouses' },
      { title: '库存查询', icon: <Package size={16} />, path: '/inventory/stock' },
      { title: '采购订单', icon: <ShoppingCart size={16} />, path: '/inventory/purchase' },
      { title: '销售订单', icon: <TrendingUp size={16} />, path: '/inventory/sales' },
    ],
  },
  {
    title: '生产制造 MRP',
    icon: <Factory size={20} />,
    path: '/mrp',
    children: [
      { title: '部门管理', icon: <Users size={16} />, path: '/mrp/departments' },
      { title: 'BOM管理', icon: <GitBranch size={16} />, path: '/mrp/boms' },
      { title: '工艺路线', icon: <Settings size={16} />, path: '/mrp/routings' },
      { title: '工作中心', icon: <Factory size={16} />, path: '/mrp/workcenters' },
      { title: '工序管理', icon: <Cog size={16} />, path: '/mrp/operations' },
      { title: '生产订单', icon: <ClipboardList size={16} />, path: '/mrp/production' },
      { title: 'MRP计划', icon: <CalendarDays size={16} />, path: '/mrp/plans' },
    ],
  },
];

export function Layout() {
  const location = useLocation();
  const [expandedMenus, setExpandedMenus] = useState<string[]>(['财务管理', '进销存管理', '生产制造 MRP']);

  const toggleMenu = (title: string) => {
    setExpandedMenus((prev) =>
      prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]
    );
  };

  const isActive = (path: string) => {
    return location.pathname.startsWith(path);
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-800 text-white flex flex-col">
        <div className="p-6 border-b border-slate-700">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Factory className="text-blue-400" />
            <span>ERP 管理系统</span>
          </h1>
        </div>

        <nav className="flex-1 p-4">
          <ul className="space-y-2">
            {menuItems.map((item) => (
              <li key={item.title}>
                {item.children ? (
                  <div>
                    <button
                      onClick={() => toggleMenu(item.title)}
                      className={`w-full flex items-center justify-between p-3 rounded-lg transition-colors ${
                        isActive(item.path || '')
                          ? 'bg-blue-600 text-white'
                          : 'hover:bg-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {item.icon}
                        <span>{item.title}</span>
                      </div>
                      {expandedMenus.includes(item.title) ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronRight size={16} />
                      )}
                    </button>
                    {expandedMenus.includes(item.title) && (
                      <ul className="ml-4 mt-2 space-y-1">
                        {item.children.map((child) => (
                          <li key={child.path}>
                            <Link
                              to={child.path || ''}
                              className={`flex items-center gap-2 p-2 rounded-lg transition-colors ${
                                location.pathname === child.path
                                  ? 'bg-blue-500 text-white'
                                  : 'hover:bg-slate-700 text-slate-300'
                              }`}
                            >
                              {child.icon}
                              <span>{child.title}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <Link
                    to={item.path || ''}
                    className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                      location.pathname === item.path
                        ? 'bg-blue-600 text-white'
                        : 'hover:bg-slate-700'
                    }`}
                  >
                    {item.icon}
                    <span>{item.title}</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <div className="p-4 border-t border-slate-700 text-sm text-slate-400">
          <p>© 2026 Supabase ERP</p>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <header className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-800">
              {menuItems.find((item) => isActive(item.path || ''))?.title || '首页'}
            </h2>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-500">欢迎登录</span>
              <button 
                onClick={() => {
                  if (typeof (window as any).AIApp !== 'undefined') {
                    (window as any).AIApp.Auth?.login();
                  } else {
                    window.location.href = '/login';
                  }
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                登录
              </button>
            </div>
          </div>
        </header>

        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
