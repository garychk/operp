import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Card } from 'antd';
import { TeamOutlined, SafetyOutlined, MenuOutlined, FileTextOutlined, SettingOutlined, BookOutlined, BranchesOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';

const menuItems: MenuProps['items'] = [
  { key: 'users', label: '用户管理', icon: <TeamOutlined /> },
  { key: 'roles', label: '角色管理', icon: <SafetyOutlined /> },
  { key: 'menus', label: '菜单管理', icon: <MenuOutlined /> },
  { key: 'settings', label: '系统设置', icon: <SettingOutlined /> },
  { key: 'dictionaries', label: '数据字典', icon: <BookOutlined /> },
  { key: 'workflow', label: '流程配置', icon: <BranchesOutlined /> },
  { key: 'logs', label: '系统日志', icon: <FileTextOutlined /> },
];

export function SystemModule() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname.split('/').pop() || 'users';

  const handleMenuClick = (key: string) => {
    navigate(key);
  };

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <aside style={{ width: 256, background: '#fff', borderRight: '1px solid #f0f0f0' }}>
        <Card
          size="small"
          style={{ borderRadius: 0, border: 'none', borderBottom: '1px solid #f0f0f0' }}
        >
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: '#262626' }}>
              系统管理
            </h2>
            <p style={{ fontSize: 12, color: '#8c8c8c', margin: '4px 0 0 0' }}>
              用户、角色、权限、设置、日志
            </p>
          </div>
        </Card>
        <Menu
          mode="inline"
          selectedKeys={[currentPath]}
          items={menuItems}
          onClick={({ key }) => handleMenuClick(key)}
          style={{ borderRight: 'none' }}
        />
      </aside>
      <main style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}



