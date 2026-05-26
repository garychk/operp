import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Card } from 'antd';
import {
  ContainerOutlined,
  ProfileOutlined,
  RiseOutlined,
  FallOutlined,
  BuildOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';

const menuItems: MenuProps['items'] = [
  { key: 'subjects', label: '会计科目', icon: <ContainerOutlined /> },
  { key: 'vouchers', label: '凭证管理', icon: <ProfileOutlined /> },
  { key: 'receivables', label: '应收账款', icon: <RiseOutlined /> },
  { key: 'payables', label: '应付账款', icon: <FallOutlined /> },
  { key: 'assets', label: '固定资产', icon: <BuildOutlined /> },
];

export function FinanceModule() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname.split('/').pop() || 'subjects';

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
              财务管理
            </h2>
            <p style={{ fontSize: 12, color: '#8c8c8c', margin: '4px 0 0 0' }}>
              会计核算与资产管理
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
