import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Select, Card, message, Row, Col, Statistic } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';

type Inventory = Tables['erp_inventory_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];

const { Option } = Select;

export function Inventory() {
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedWarehouse, setSelectedWarehouse] = useState<number | null>(null);

  useEffect(() => {
    fetchInventory();
    fetchProducts();
    fetchWarehouses();
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
      message.error('获取数据失败');
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
      title: '产品编码',
      dataIndex: 'product_id',
      key: 'product_id',
      render: (productId: number) => getProductCode(productId),
    },
    {
      title: '产品名称',
      dataIndex: 'product_id',
      key: 'product_name',
      render: (productId: number) => getProductName(productId),
    },
    {
      title: '仓库',
      dataIndex: 'warehouse_id',
      key: 'warehouse_id',
      render: (warehouseId: number) => getWarehouseName(warehouseId),
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      render: (qty: number) => (qty ?? 0).toLocaleString(),
    },
    {
      title: '可用数量',
      dataIndex: 'available_quantity',
      key: 'available_quantity',
      render: (qty: number) => (qty ?? 0).toLocaleString(),
    },
    {
      title: '锁定数量',
      dataIndex: 'locked_quantity',
      key: 'locked_quantity',
      render: (qty: number) => (qty ?? 0).toLocaleString(),
    },
    {
      title: '单位成本',
      dataIndex: 'unit_cost',
      key: 'unit_cost',
      render: (cost: number) => `¥${(cost ?? 0).toLocaleString()}`,
    },
    {
      title: '总成本',
      dataIndex: 'total_cost',
      key: 'total_cost',
      render: (cost: number) => `¥${(cost ?? 0).toLocaleString()}`,
    },
    {
      title: '状态',
      key: 'status',
      render: (_: any, record: Inventory) => {
        const status = getSafetyStatus(record);
        return (
          <Tag color={status === 'low' ? 'error' : 'success'}>
            {status === 'low' ? '库存不足' : '正常'}
          </Tag>
        );
      },
    },
  ];

  return (
    <Card variant="borderless" title="库存管理" extra={<Button icon={<ReloadOutlined />} onClick={fetchInventory}>刷新</Button>}>      
      
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title="库存总数量"
              value={filteredInventory.reduce((sum, item) => sum + (item.quantity || 0), 0)}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="库存总价值"
              value={totalValue}
              prefix="¥"
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="库存品种数"
              value={filteredInventory.length}
            />
          </Card>
        </Col>
      </Row>

      <div style={{ marginBottom: 16, display: 'flex', gap: 16 }}>
        <Input
          placeholder="搜索产品名称或编码..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{ width: 300 }}
        />
        <Select
          placeholder="全部仓库"
          value={selectedWarehouse}
          onChange={(value) => setSelectedWarehouse(value)}
          style={{ width: 200 }}
          allowClear
        >
          {warehouses.map((w) => (
            <Option key={w.id} value={w.id}>{w.name}</Option>
          ))}
        </Select>
      </div>

      <Table
        columns={columns}
        dataSource={filteredInventory}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />
    </Card>
  );
}
