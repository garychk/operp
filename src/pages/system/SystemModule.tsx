import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Card } from 'antd';
import { TeamOutlined, SafetyOutlined, MenuOutlined, FileTextOutlined, SettingOutlined, BookOutlined, BranchesOutlined, ApartmentOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useTranslation } from 'react-i18next';

export function SystemModule() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname.split('/').pop() || 'users';

  const menuItems: MenuProps['items'] = [
    { key: 'users', label: t('systemModule.users'), icon: <TeamOutlined /> },
    { key: 'tenants', label: t('systemModule.tenants'), icon: <ApartmentOutlined /> },
    { key: 'roles', label: t('systemModule.roles'), icon: <SafetyOutlined /> },
    { key: 'menus', label: t('systemModule.menus'), icon: <MenuOutlined /> },
    { key: 'settings', label: t('systemModule.settings'), icon: <SettingOutlined /> },
    { key: 'dictionaries', label: t('systemModule.dictionaries'), icon: <BookOutlined /> },
    { key: 'workflow', label: t('systemModule.workflow'), icon: <BranchesOutlined /> },
    { key: 'logs', label: t('systemModule.logs'), icon: <FileTextOutlined /> },
  ];

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
              {t('systemModule.title')}
            </h2>
            <p style={{ fontSize: 12, color: '#8c8c8c', margin: '4px 0 0 0' }}>
              {t('systemModule.subtitle')}
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



