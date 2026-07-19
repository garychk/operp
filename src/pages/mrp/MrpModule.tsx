import { Outlet, useLocation, useNavigate } from 'react-router-dom';
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

const menuItems: MenuProps['items'] = [
  { key: 'boms', label: 'BOM管理', icon: <FileTextOutlined /> },
  { key: 'routings', label: '工艺路线', icon: <SettingOutlined /> },
  { key: 'workcenters', label: '工作中心', icon: <BuildOutlined /> },
  { key: 'operations', label: '工序管理', icon: <ToolOutlined /> },
  { key: 'production', label: '生产订单', icon: <ProfileOutlined /> },
  { key: 'plans', label: 'MRP计划', icon: <CalendarOutlined /> },
  { key: 'quality', label: '检验管理', icon: <ExperimentOutlined /> },
];

export function MrpModule() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname.split('/').pop() || 'boms';

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
              生产制造
            </h2>
            <p style={{ fontSize: 12, color: '#8c8c8c', margin: '4px 0 0 0' }}>
              物料需求与生产计划
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
