import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Menu, Card } from 'antd';
import {
  FileTextOutlined,
  SettingOutlined,
  ToolOutlined,
  BuildOutlined,
  ProfileOutlined,
  CalendarOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';

export function MrpModule() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname.split('/').pop() || 'boms';

  const menuItems: MenuProps['items'] = [
    { key: 'boms', label: t('menu.boms'), icon: <FileTextOutlined /> },
    { key: 'routings', label: t('menu.routings'), icon: <SettingOutlined /> },
    { key: 'workcenters', label: t('menu.workcenters'), icon: <BuildOutlined /> },
    { key: 'operations', label: t('menu.operations'), icon: <ToolOutlined /> },
    { key: 'production', label: t('menu.production'), icon: <ProfileOutlined /> },
    { key: 'plans', label: t('menu.plans'), icon: <CalendarOutlined /> },
    { key: 'quality', label: t('menu.quality'), icon: <ExperimentOutlined /> },
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
              {t('menu.mrp')}
            </h2>
            <p style={{ fontSize: 12, color: '#8c8c8c', margin: '4px 0 0 0' }}>
              {t('mrp.module.subtitle')}
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
