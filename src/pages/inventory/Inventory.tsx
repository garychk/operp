import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Select, Card, message, Row, Col, Statistic, Space } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import { supabase } from '@/utils/supabase';
import type { Tables } from '@/utils/supabase';
import { useTranslation } from 'react-i18next';
import { SuperTable } from '@/components/SuperTable';

type Inventory = Tables['erp_inventory_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];
type Bin = Tables['erp_bins_s_539dcf81_b']['Row'];

const { Option } = Select;

export function Inventory() {
  const { t } = useTranslation();
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedWarehouse, setSelectedWarehouse] = useState<number | null>(null);

  useEffect(() => {
    fetchInventory();
    fetchProducts();
    fetchWarehouses();
    fetchBins();
  }, []);

  const fetchInventory = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_inventory_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setInventory(data || []);
    } catch (error) {
      console.error('Error fetching inventory:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_products_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error fetching products:', error);
    }
  };

  const fetchWarehouses = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_warehouses_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error('Error fetching warehouses:', error);
    }
  };

  const fetchBins = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_bins_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setBins(data || []);
    } catch (error) {
      console.error('Error fetching bins:', error);
    }
  };

  const getProductName = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.name || '-';
  };

  const getProductCode = (productId: number | null) => {
    const product = products.find((p) => p.id === productId);
    return product?.code || '-';
  };

  const getWarehouseName = (warehouseId: number | null) => {
    const warehouse = warehouses.find((w) => w.id === warehouseId);
    return warehouse?.name || '-';
  };

  const getBinName = (locationId: number | null) => {
    const bin = bins.find((b) => b.id === locationId);
    return bin?.name || '-';
  };

  const getSafetyStatus = (item: Inventory) => {
    const product = products.find((p) => p.id === item.product_id);
    if (!product || !product.safety_stock) return 'normal';
    if (item.available_quantity === null) return 'normal';
    if (item.available_quantity <= product.safety_stock) return 'low';
    return 'normal';
  };

  const filteredInventory = inventory.filter((item) => {
    const matchesSearch =
      getProductName(item.product_id).toLowerCase().includes(searchTerm.toLowerCase()) ||
      getProductCode(item.product_id).toLowerCase().includes(searchTerm.toLowerCase());
    const matchesWarehouse = selectedWarehouse ? item.warehouse_id === selectedWarehouse : true;
    return matchesSearch && matchesWarehouse;
  });

  const totalValue = filteredInventory.reduce((sum, item) => sum + (item.total_cost || 0), 0);

  const columns = [
    {
      title: t('stockInventory.productCode'),
      dataIndex: 'product_id',
      key: 'product_id',
      render: (productId: number) => getProductCode(productId),
    },
    {
      title: t('stockInventory.productName'),
      dataIndex: 'product_id',
      key: 'product_name',
      render: (productId: number) => getProductName(productId),
    },
    {
      title: t('stockInventory.warehouse'),
      dataIndex: 'warehouse_id',
      key: 'warehouse_id',
      render: (warehouseId: number) => getWarehouseName(warehouseId),
    },
    {
      title: t('stockInventory.bin'),
      dataIndex: 'location_id',
      key: 'location_id',
      render: (locationId: number) => getBinName(locationId),
    },
    {
      title: t('stockInventory.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      render: (qty: number) => (qty ?? 0).toLocaleString(),
    },
    {
      title: t('stockInventory.availableQuantity'),
      dataIndex: 'available_quantity',
      key: 'available_quantity',
      render: (qty: number) => (qty ?? 0).toLocaleString(),
    },
    {
      title: t('stockInventory.lockedQuantity'),
      dataIndex: 'locked_quantity',
      key: 'locked_quantity',
      render: (qty: number) => (qty ?? 0).toLocaleString(),
    },
    {
      title: t('stockInventory.unitCost'),
      dataIndex: 'unit_cost',
      key: 'unit_cost',
      render: (cost: number) => `¥${(cost ?? 0).toLocaleString()}`,
    },
    {
      title: t('stockInventory.totalCost'),
      dataIndex: 'total_cost',
      key: 'total_cost',
      render: (cost: number) => `¥${(cost ?? 0).toLocaleString()}`,
    },
    {
      title: t('common.status'),
      key: 'status',
      render: (_: any, record: Inventory) => {
        const status = getSafetyStatus(record);
        return (
          <Tag color={status === 'low' ? 'error' : 'success'}>
            {status === 'low' ? t('stockInventory.lowStock') : t('stockInventory.normal')}
          </Tag>
        );
      },
    },
  ];

  return (
    <Card className='mainContent' variant="borderless" title={t('stockInventory.title')} extra={<Button icon={<ReloadOutlined />} onClick={fetchInventory}>{t('common.refresh')}</Button>}>
      
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('stockInventory.totalQuantity')}
              value={filteredInventory.reduce((sum, item) => sum + (item.quantity || 0), 0)}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('stockInventory.totalValue')}
              value={totalValue}
              prefix="¥"
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title={t('stockInventory.totalVarieties')}
              value={filteredInventory.length}
            />
          </Card>
        </Col>
      </Row>

      <div style={{ marginBottom: 16, display: 'flex', gap: 16 }}>
        
      </div>

      <SuperTable
        columns={columns}
        dataSource={filteredInventory}
        storageKey="stockInventory"
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        toolbarActions={['export']}
        queryBar={<Space>
          <Input
          placeholder={t('stockInventory.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
        <Select
          placeholder={t('stockInventory.allWarehouses')}
          value={selectedWarehouse}
          onChange={(value) => setSelectedWarehouse(value)}
          style={{ width: 200 }}
          allowClear
        >
          {warehouses.map((w) => (
            <Option key={w.id} value={w.id}>{w.name}</Option>
          ))}
        </Select>
        </Space>}
      />
    </Card>
  );
}
