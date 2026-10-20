import { useEffect, useMemo, useState } from 'react';
import { Button, Card, DatePicker, Input, Select, Tag, message, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import {
  normalizeInventoryTransactionType,
} from '../../constants/inventoryTransactionTypes';
import { useInventoryTransactionTypes } from '../../hooks/useInventoryTransactionTypes';
import { SuperTable } from '../../components/SuperTable';
import { ProductSearchSelect } from '../../components/ProductSearchSelect';
import { ProductUnit } from '../../components/ProductUnit';
import { formatMoney } from '../../utils/money';

type InventoryTransaction = Tables['erp_inventory_transactions_s_539dcf81_b']['Row'];
type Product = Tables['erp_products_s_539dcf81_b']['Row'];
type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];
type Bin = Tables['erp_bins_s_539dcf81_b']['Row'];

const { RangePicker } = DatePicker;

export function InventoryTransactions() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<InventoryTransaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState<string | undefined>();
  const [selectedProduct, setSelectedProduct] = useState<number | undefined>();
  const [selectedWarehouse, setSelectedWarehouse] = useState<number | undefined>();
  const [selectedBin, setSelectedBin] = useState<number | undefined>();
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const { options: typeOptions, getLabel: getTypeLabel } = useInventoryTransactionTypes();

  useEffect(() => {
    void fetchAll();
  }, []);

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [txRes, productRes, warehouseRes, binRes] = await Promise.all([
        supabase
          .from('erp_inventory_transactions_s_539dcf81_b')
          .select('*')
          .eq('is_deleted', 'n')
          .order('transaction_date', { ascending: false })
          .order('id', { ascending: false }),
        supabase
          .from('erp_products_s_539dcf81_b')
          .select('*')
          .eq('is_deleted', 'n'),
        supabase
          .from('erp_warehouses_s_539dcf81_b')
          .select('*')
          .eq('is_deleted', 'n'),
        supabase
          .from('erp_bins_s_539dcf81_b')
          .select('*')
          .eq('is_deleted', 'n'),
      ]);

      if (txRes.error) throw txRes.error;
      if (productRes.error) throw productRes.error;
      if (warehouseRes.error) throw warehouseRes.error;
      if (binRes.error) throw binRes.error;

      setRows((txRes.data || []) as InventoryTransaction[]);
      setProducts((productRes.data || []) as Product[]);
      setWarehouses((warehouseRes.data || []) as Warehouse[]);
      setBins((binRes.data || []) as Bin[]);
    } catch (error) {
      console.error('Error fetching inventory transactions:', error);
      message.error(t('inventoryTransactions.messages.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const getProduct = (productId: number | null) =>
    products.find((p) => p.id === productId);

  const getWarehouse = (warehouseId: number | null) =>
    warehouses.find((w) => w.id === warehouseId);
  const getBin = (binId: number | null) => bins.find((b) => b.id === binId);

  const getTransactionTypeLabel = (value: string | null) =>
    getTypeLabel(normalizeInventoryTransactionType(value));

  const availableBins = useMemo(
    () =>
      selectedWarehouse
        ? bins.filter((bin) => bin.warehouse_id === selectedWarehouse)
        : bins,
    [bins, selectedWarehouse],
  );

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const normalizedType = normalizeInventoryTransactionType(row.transaction_type) as string;
      const product = getProduct(row.product_id);
      const warehouse = getWarehouse(row.warehouse_id);
      const bin = getBin(row.location_id);
      const productText = `${product?.code || ''} ${product?.name || ''}`.trim();
      const warehouseText = `${warehouse?.code || ''} ${warehouse?.name || ''}`.trim();
      const binText = `${bin?.code || ''} ${bin?.name || ''}`.trim();
      const matchesSearch =
        productText.toLowerCase().includes(searchTerm.toLowerCase()) ||
        warehouseText.toLowerCase().includes(searchTerm.toLowerCase()) ||
        binText.toLowerCase().includes(searchTerm.toLowerCase()) ||
        String(row.transaction_no || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        String(row.remark || '').toLowerCase().includes(searchTerm.toLowerCase());
      const matchesType = selectedType ? normalizedType === selectedType : true;
      const matchesProduct = selectedProduct ? row.product_id === selectedProduct : true;
      const matchesWarehouse = selectedWarehouse ? row.warehouse_id === selectedWarehouse : true;
      const matchesBin = selectedBin ? row.location_id === selectedBin : true;
      const matchesDate =
        !dateRange?.[0] ||
        !dateRange?.[1] ||
        !row.transaction_date ||
        (dayjs(row.transaction_date).isAfter(dateRange[0].startOf('day').subtract(1, 'millisecond')) &&
          dayjs(row.transaction_date).isBefore(dateRange[1].endOf('day').add(1, 'millisecond')));
      return matchesSearch && matchesType && matchesProduct && matchesWarehouse && matchesBin && matchesDate;
    });
  }, [dateRange, getBin, getProduct, getWarehouse, rows, searchTerm, selectedBin, selectedProduct, selectedType, selectedWarehouse]);

  const totalQty = filteredRows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const totalCost = filteredRows.reduce((sum, row) => sum + (Number(row.total_cost) || 0), 0);

  const columns = [
    {
      title: t('inventoryTransactions.columns.transactionNo'),
      dataIndex: 'transaction_no',
      key: 'transaction_no',
      ellipsis: true,
      width: 180,
    },
    {
      title: t('inventoryTransactions.columns.date'),
      dataIndex: 'transaction_date',
      key: 'transaction_date',
      width: 100,
    },
    {
      title: t('inventoryTransactions.columns.type'),
      dataIndex: 'transaction_type',
      key: 'transaction_type',
      width: 120,
      render: (value: string) => (
        <Tag color="blue">{getTransactionTypeLabel(normalizeInventoryTransactionType(value))}</Tag>
      ),
    },
    {
      title: t('inventoryTransactions.columns.product'),
      key: 'product',
      width: 220,
      render: (_: unknown, record: InventoryTransaction) => {
        const product = getProduct(record.product_id);
        return product ? `${product.code} ${product.name}` : '-';
      },
    },
    {
      title: t('inventoryTransactions.columns.warehouse'),
      key: 'warehouse',
      width: 160,
      render: (_: unknown, record: InventoryTransaction) => {
        const warehouse = getWarehouse(record.warehouse_id);
        return warehouse ? `${warehouse.code} ${warehouse.name}` : '-';
      },
    },
    {
      title: t('inventoryTransactions.columns.bin'),
      key: 'bin',
      width: 160,
      render: (_: unknown, record: InventoryTransaction) => {
        const bin = getBin(record.location_id);
        return bin ? `${bin.code} ${bin.name}` : '-';
      },
    },
    {
      title: t('inventoryTransactions.columns.batchNo'),
      dataIndex: 'batch_no',
      key: 'batch_no',
      width: 100,
      render: (value: string | null) => value || '-',
    },
    {
      title: t('inventoryTransactions.columns.quantity'),
      dataIndex: 'quantity',
      key: 'quantity',
      width: 140,
      align: 'right' as const,
      render: (value: number | null, record: InventoryTransaction) => (
        <span>
          {(Number(value) || 0).toLocaleString()}
          <span style={{ color: '#999', marginLeft: 4, fontSize: 12 }}>
            <ProductUnit productId={record.product_id} usageType="inventory" />
          </span>
        </span>
      ),
    },
    {
      title: t('inventoryTransactions.columns.unitCost'),
      dataIndex: 'unit_cost',
      key: 'unit_cost',
      width: 120,
      align: 'right' as const,
      render: (value: number | null) => formatMoney(value),
    },
    {
      title: t('inventoryTransactions.columns.totalCost'),
      dataIndex: 'total_cost',
      key: 'total_cost',
      width: 120,
      align: 'right' as const,
      render: (value: number | null) => formatMoney(value),
    },
    {
      title: t('inventoryTransactions.columns.remark'),
      dataIndex: 'remark',
      key: 'remark',
      ellipsis: true,
      width: 120,
      render: (value: string | null) => value || '-',
    },
  ];

  return (
    <Card
      variant="borderless"
      title={t("inventoryTransactions.title")}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void fetchAll()}>
          {t("common.refresh")}
        </Button>
      }
    >
      <div style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">
          {t("inventoryTransactions.subtitle")}
        </Typography.Text>
      </div>

      <div
        style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}
      >
        <Card size="small" style={{ minWidth: 200 }}>
          <Typography.Text type="secondary">
            {t("inventoryTransactions.stats.totalRows")}
          </Typography.Text>
          <Typography.Title level={4} style={{ margin: "4px 0 0" }}>
            {filteredRows.length}
          </Typography.Title>
        </Card>
        <Card size="small" style={{ minWidth: 200 }}>
          <Typography.Text type="secondary">
            {t("inventoryTransactions.stats.totalQty")}
          </Typography.Text>
          <Typography.Title level={4} style={{ margin: "4px 0 0" }}>
            {totalQty.toLocaleString()}
          </Typography.Title>
        </Card>
        <Card size="small" style={{ minWidth: 220 }}>
          <Typography.Text type="secondary">
            {t("inventoryTransactions.stats.totalCost")}
          </Typography.Text>
          <Typography.Title level={4} style={{ margin: "4px 0 0" }}>
            {formatMoney(totalCost)}
          </Typography.Title>
        </Card>
      </div>

      <SuperTable
        columns={columns}
        dataSource={filteredRows}
        toolbarActions={['export']}
        rowKey="id"
        storageKey="inventoryTransactions"
        loading={loading}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 1500 }}
        queryBar={
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder={t("inventoryTransactions.searchPlaceholder")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{ width: 160 }}
            />
            <Select
              allowClear
              placeholder={t("inventoryTransactions.typePlaceholder")}
              value={selectedType}
              onChange={(value) => setSelectedType(value)}
              options={typeOptions.map((item) => ({
                value: item.value,
                label: item.label,
              }))}
              style={{ width: 140 }}
            />
            <ProductSearchSelect
              value={selectedProduct}
              onChange={(v) => setSelectedProduct(v as number | undefined)}
              valueField="id"
              allowClear
              placeholder={t("inventoryTransactions.productPlaceholder")}
              style={{ width: 180 }}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t("inventoryTransactions.warehousePlaceholder")}
              value={selectedWarehouse}
              onChange={(value) => {
                setSelectedWarehouse(value);
                setSelectedBin(undefined);
              }}
              options={warehouses.map((w) => ({
                value: w.id,
                label: `${w.code} ${w.name}`,
              }))}
              style={{ width: 160 }}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t("inventoryTransactions.binPlaceholder")}
              value={selectedBin}
              onChange={(value) => setSelectedBin(value)}
              options={availableBins.map((b) => ({
                value: b.id,
                label: `${b.code} ${b.name}`,
              }))}
              style={{ width: 160 }}
            />
            <RangePicker
              value={dateRange as [Dayjs, Dayjs] | null}
              onChange={(value) => setDateRange(value || null)}
            />
            <Button
              onClick={() => {
                setSearchTerm("");
                setSelectedType(undefined);
                setSelectedProduct(undefined);
                setSelectedWarehouse(undefined);
                setSelectedBin(undefined);
                setDateRange(null);
              }}
            >
              {t("common.reset")}
            </Button>
          </div>
        }
      />
    </Card>
  );
}
