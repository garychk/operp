import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Spin } from 'antd';
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  TeamOutlined,
  ShopOutlined,
  InboxOutlined,
  DollarOutlined,
  ShoppingCartOutlined,
  ProfileOutlined,
  ForkOutlined,
  GiftOutlined,
} from '@ant-design/icons';
import { supabase } from '../utils/supabase';
import { useTranslation } from 'react-i18next';

interface DashboardStats {
  totalCustomers: number;
  totalSuppliers: number;
  totalProducts: number;
  pendingPurchaseOrders: number;
  pendingSalesOrders: number;
  totalInventoryValue: number;
}

export function Dashboard() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<DashboardStats>({
    totalCustomers: 0,
    totalSuppliers: 0,
    totalProducts: 0,
    pendingPurchaseOrders: 0,
    pendingSalesOrders: 0,
    totalInventoryValue: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);

      const [
        { count: customersCount },
        { count: suppliersCount },
        { count: productsCount },
        { count: purchaseOrdersCount },
        { count: salesOrdersCount },
        { data: inventoryData },
      ] = await Promise.all([
        supabase.from('erp_customers_s_539dcf81_b').select('*', { count: 'exact', head: true }),
        supabase.from('erp_suppliers_s_539dcf81_b').select('*', { count: 'exact', head: true }),
        supabase.from('erp_products_s_539dcf81_b').select('*', { count: 'exact', head: true }),
        supabase.from('erp_purchase_orders_s_539dcf81_b').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
        supabase.from('erp_sales_orders_s_539dcf81_b').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
        supabase.from('erp_inventory_s_539dcf81_b').select('total_cost'),
      ]);

      const totalInventoryValue = inventoryData?.reduce((sum, item) => sum + (item.total_cost || 0), 0) || 0;

      setStats({
        totalCustomers: customersCount || 0,
        totalSuppliers: suppliersCount || 0,
        totalProducts: productsCount || 0,
        pendingPurchaseOrders: purchaseOrdersCount || 0,
        pendingSalesOrders: salesOrdersCount || 0,
        totalInventoryValue,
      });
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 400 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Card className='mainContent' variant="borderless">
      <h2 style={{ marginBottom: 24 }}>{t('dashboard.title')}</h2>
      <p style={{ color: '#666', marginBottom: 24 }}>{t('dashboard.welcome')}</p>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic
              title={t('dashboard.customersCount')}
              value={stats.totalCustomers}
              prefix={<TeamOutlined style={{ color: '#1677ff', marginRight: 8 }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic
              title={t('dashboard.suppliersCount')}
              value={stats.totalSuppliers}
              prefix={<ShopOutlined style={{ color: '#52c41a', marginRight: 8 }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic
              title={t('dashboard.productsCount')}
              value={stats.totalProducts}
              prefix={<InboxOutlined style={{ color: '#722ed1', marginRight: 8 }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic
              title={t('dashboard.inventoryValue')}
              value={stats.totalInventoryValue}
              prefix={<DollarOutlined style={{ color: '#faad14', marginRight: 8 }} />}
              formatter={(value) => `¥${value.toLocaleString()}`}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic
              title={t('dashboard.pendingPurchaseOrders')}
              value={stats.pendingPurchaseOrders}
              prefix={<ShoppingCartOutlined style={{ color: '#fa8c16', marginRight: 8 }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic
              title={t('dashboard.pendingSalesOrders')}
              value={stats.pendingSalesOrders}
              prefix={<ProfileOutlined style={{ color: '#eb2f96', marginRight: 8 }} />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={24} lg={12}>
          <Card title={t('dashboard.financeOverview')}>
            <Row gutter={16}>
              <Col span={12}>
                <Card bordered={false} style={{ background: '#f6ffed' }}>
                  <Statistic
                    title={t('dashboard.monthlyIncome')}
                    value={0}
                    prefix={<ArrowUpOutlined style={{ color: '#52c41a' }} />}
                    suffix={t('dashboard.yuan')}
                    valueStyle={{ color: '#52c41a' }}
                  />
                </Card>
              </Col>
              <Col span={12}>
                <Card bordered={false} style={{ background: '#fff2f0' }}>
                  <Statistic
                    title={t('dashboard.monthlyExpense')}
                    value={0}
                    prefix={<ArrowDownOutlined style={{ color: '#ff4d4f' }} />}
                    suffix={t('dashboard.yuan')}
                    valueStyle={{ color: '#ff4d4f' }}
                  />
                </Card>
              </Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={t('dashboard.productionOverview')}>
            <Row gutter={16}>
              <Col span={12}>
                <Card bordered={false} style={{ background: '#e6f4ff' }}>
                  <Statistic
                    title={t('dashboard.activeProductionOrders')}
                    value={0}
                    prefix={<ForkOutlined style={{ color: '#1677ff' }} />}
                    valueStyle={{ color: '#1677ff' }}
                  />
                </Card>
              </Col>
              <Col span={12}>
                <Card bordered={false} style={{ background: '#f9f0ff' }}>
                  <Statistic
                    title={t('dashboard.monthlyCompleted')}
                    value={0}
                    prefix={<GiftOutlined style={{ color: '#722ed1' }} />}
                    valueStyle={{ color: '#722ed1' }}
                  />
                </Card>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>
    </Card>
  );
}
