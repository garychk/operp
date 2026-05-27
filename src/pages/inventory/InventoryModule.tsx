import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Menu, Card } from 'antd';
import {
  TeamOutlined,
  ShopOutlined,
  InboxOutlined,
  AppstoreOutlined,
  ShoppingOutlined,
  ShoppingCartOutlined,
  FileTextOutlined,
  ProfileOutlined,
  TruckOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';

const menuItems: MenuProps['items'] = [
  { key: 'customers', label: '客户管理', icon: <TeamOutlined /> },
  { key: 'suppliers', label: '供应商管理', icon: <ShopOutlined /> },
  { key: 'products', label: '产品管理', icon: <InboxOutlined /> },
  { key: 'warehouses', label: '仓库管理', icon: <AppstoreOutlined /> },
  { key: 'stock', label: '库存管理', icon: <ShoppingOutlined /> },
  { key: 'purchase', label: '采购订单', icon: <ShoppingCartOutlined /> },
  { key: 'purchase-receipts', label: '采购入库', icon: <ProfileOutlined /> },
  { key: 'sales', label: '销售订单', icon: <FileTextOutlined /> },
  { key: 'sales-deliveries', label: '销售出货', icon: <TruckOutlined /> },
];

export function InventoryModule() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname.split('/').pop() || 'customers';

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
              进销存管理
            </h2>
            <p style={{ fontSize: 12, color: '#8c8c8c', margin: '4px 0 0 0' }}>
              采购、销售、库存一体化
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
