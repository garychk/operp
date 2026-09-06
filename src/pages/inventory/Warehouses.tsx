import { useEffect, useMemo, useState } from 'react';
import type { Key } from 'react';
import { Button, Card, Form, Input, Modal, Select, Space, Table, Tag, message, Checkbox } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '@/utils/supabase';
import { logWithTiming } from '@/utils/logger';
import type { Tables } from '@/utils/supabase';
import { SuperTable } from '@/components/SuperTable';
import { SupaModal } from '@/components/SupaModal';
import SimpleModal from '@/components/SimpleModal';
import { useTranslation } from 'react-i18next';

type Warehouse = Tables['erp_warehouses_s_539dcf81_b']['Row'];
type Employee = Tables['erp_employees_s_539dcf81_b']['Row'];
type Bin = Tables['erp_bins_s_539dcf81_b']['Row'];

const warehouseTable = 'erp_warehouses_s_539dcf81_b';
const binTable = 'erp_bins_s_539dcf81_b';

export function Warehouses() {
  const { t } = useTranslation();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [bins, setBins] = useState<Bin[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null);
  const [warehouseForm] = Form.useForm();
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<number | null>(null);
  const [selectedWarehouse, setSelectedWarehouse] = useState<Warehouse | null>(null);
  const [binModalOpen, setBinModalOpen] = useState(false);
  const [editingBin, setEditingBin] = useState<Bin | null>(null);
  const [binForm] = Form.useForm();
  const [binSearchTerm, setBinSearchTerm] = useState('');

  useEffect(() => {
    void fetchWarehouses();
    void fetchEmployees();
  }, []);

  useEffect(() => {
    if (warehouses.length && selectedWarehouseId === null) {
      setSelectedWarehouseId(warehouses[0].id);
      setSelectedWarehouse(warehouses[0]);
    }
  }, [warehouses, selectedWarehouseId]);

  useEffect(() => {
    if (selectedWarehouseId) {
      void fetchBins(selectedWarehouseId);
      setSelectedWarehouse(warehouses.find((w) => w.id === selectedWarehouseId) || null);
    } else {
      setBins([]);
      setSelectedWarehouse(null);
    }
  }, [selectedWarehouseId, warehouses]);

  const fetchWarehouses = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(warehouseTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setWarehouses(data || []);
    } catch (error) {
      console.error('Error fetching warehouses:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchBins = async (warehouseId: number) => {
    try {
      const { data, error } = await supabase
        .from(binTable)
        .select('*')
        .eq('is_deleted', 'n')
        .eq('warehouse_id', warehouseId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });
      if (error) throw error;
      setBins(data || []);
    } catch (error) {
      console.error('Error fetching bins:', error);
      message.error(t('common.fetchFailed'));
    }
  };

  const fetchEmployees = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_employees_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setEmployees(data || []);
    } catch (error) {
      console.error('Error fetching employees:', error);
    }
  };

  const getManagerName = (managerId: number | null) => {
    const employee = employees.find((e) => e.id === managerId);
    return employee?.name || '-';
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingWarehouse) {
        await logWithTiming('更新仓库', 'UPDATE', async () => {
          const { error } = await supabase
            .from(warehouseTable)
            .update(values)
            .eq('id', editingWarehouse.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming('新增仓库', 'INSERT', async () => {
          const { error } = await supabase
            .from(warehouseTable)
            .insert([values]);
          if (error) throw error;
        });
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      warehouseForm.resetFields();
      setEditingWarehouse(null);
      await fetchWarehouses();
    } catch (error) {
      console.error('Error saving warehouse:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: Warehouse) => {
    setEditingWarehouse(record);
    warehouseForm.setFieldsValue({
      ...record,
      is_negative_stock_allowed: record.is_negative_stock_allowed ?? false,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('inventory.warehouseDeleteConfirm'),
      onOk: async () => {
        try {
          await logWithTiming('删除仓库', 'DELETE', async () => {
            const { error } = await supabase
              .from(warehouseTable)
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success(t('common.deleteSuccess'));
          await fetchWarehouses();
        } catch (error) {
          console.error('Error deleting warehouse:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAddWarehouse = () => {
    setEditingWarehouse(null);
    warehouseForm.setFieldsValue({
      code: '',
      name: '',
      type: 'raw_material',
      location: '',
      manager_id: undefined,
      is_negative_stock_allowed: false,
      status: 'active',
    });
    setIsModalOpen(true);
  };

  const filteredWarehouses = useMemo(
    () =>
      warehouses.filter(
        (w) =>
          w.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          w.code.toLowerCase().includes(searchTerm.toLowerCase()),
      ),
    [searchTerm, warehouses],
  );

  const filteredBins = useMemo(
    () =>
      bins.filter(
        (bin) =>
          bin.name.toLowerCase().includes(binSearchTerm.toLowerCase()) ||
          bin.code.toLowerCase().includes(binSearchTerm.toLowerCase()),
      ),
    [binSearchTerm, bins],
  );

  const typeLabels: Record<string, string> = {
    raw_material: t('inventory.warehouseTypes.rawMaterial'),
    finished: t('inventory.warehouseTypes.finished'),
    semi_finished: t('inventory.warehouseTypes.semiFinished'),
    return: t('inventory.warehouseTypes.return'),
    scrap: t('inventory.warehouseTypes.scrap'),
    other: t('inventory.warehouseTypes.other'),
  };

  const warehouseColumns = [
    { title: t('common.code'), dataIndex: 'code', key: 'code' },
    { title: t('common.name'), dataIndex: 'name', key: 'name' },
    {
      title: t('common.type'),
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: t('common.location'),
      dataIndex: 'location',
      key: 'location',
      render: (text: string) => text || '-',
    },
    {
      title: t('common.manager'),
      dataIndex: 'manager_id',
      key: 'manager_id',
      render: (managerId: number) => getManagerName(managerId),
    },
    {
      title: t('common.allowNegativeStock'),
      dataIndex: 'is_negative_stock_allowed',
      key: 'is_negative_stock_allowed',
      render: (allowed: boolean) => (allowed ? t('common.yes') : t('common.no')),
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: Warehouse) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const binColumns = [
    { title: t('common.code'), dataIndex: 'code', key: 'code' },
    { title: t('common.name'), dataIndex: 'name', key: 'name' },
    { title: t('common.location'), dataIndex: 'location', key: 'location', render: (value: string | null) => value || '-' },
    { title: t('common.sortOrder'), dataIndex: 'sort_order', key: 'sort_order' },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: Bin) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditBin(record)}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteBin(record.id)}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const handleAddBin = () => {
    if (!selectedWarehouse) {
      message.warning(t('inventory.binSelectWarehouseFirst'));
      return;
    }
    setEditingBin(null);
    binForm.setFieldsValue({
      code: '',
      name: '',
      warehouse_id: selectedWarehouse.id,
      location: '',
      sort_order: 0,
      status: 'active',
    });
    setBinModalOpen(true);
  };

  const handleEditBin = (record: Bin) => {
    setEditingBin(record);
    binForm.setFieldsValue(record);
    setBinModalOpen(true);
  };

  const handleDeleteBin = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('inventory.binDeleteConfirm'),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(binTable)
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success(t('common.deleteSuccess'));
          if (selectedWarehouseId) await fetchBins(selectedWarehouseId);
        } catch (error) {
          console.error('Error deleting bin:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleBinSubmit = async (values: any) => {
    try {
      const payload = {
        ...values,
        warehouse_id: selectedWarehouseId,
        sort_order: Number(values.sort_order || 0),
      };
      if (editingBin) {
        const { error } = await supabase.from(binTable).update(payload).eq('id', editingBin.id);
        if (error) throw error;
        message.success(t('common.updateSuccess'));
      } else {
        const { error } = await supabase.from(binTable).insert([payload]);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setBinModalOpen(false);
      setEditingBin(null);
      binForm.resetFields();
      if (selectedWarehouseId) await fetchBins(selectedWarehouseId);
    } catch (error) {
      console.error('Error saving bin:', error);
      message.error(t('common.saveFailed'));
    }
  };

  return (
    <div className="mainContent">
      <Card bordered={false} title={t('inventory.warehouseTitle')} style={{ marginBottom: 16 }}>
        <SuperTable
          columns={warehouseColumns}
          dataSource={filteredWarehouses}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
          storageKey="warehouses"
          headerTitle={t('inventory.warehouseTitle')}
          rowSelection={{
            selectedRowKeys,
            onChange: setSelectedRowKeys,
          }}
          queryBar={
            <Space wrap>
              <Button type="primary" icon={<PlusOutlined />} onClick={handleAddWarehouse}>
                {t('inventory.addWarehouse')}
              </Button>
              <Input.Search
                allowClear
                placeholder={t('inventory.warehouseSearchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onSearch={() => void fetchWarehouses()}
                style={{ width: 240 }}
              />
            </Space>
          }
        />
      </Card>

      <Card
        bordered={false}
        title={t('inventory.binManagementTitle')}
        extra={
          <Space>
            <Select
              value={selectedWarehouseId}
              onChange={setSelectedWarehouseId}
              style={{ width: 240 }}
              options={warehouses.map((w) => ({ value: w.id, label: `${w.code} ${w.name}` }))}
              placeholder={t('inventory.binWarehousePlaceholder')}
              allowClear
            />
          </Space>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAddBin} disabled={!selectedWarehouseId}>
              {t('inventory.addBin')}
            </Button>
            <Input.Search
              allowClear
              placeholder={t('inventory.binSearchPlaceholder')}
              value={binSearchTerm}
              onChange={(e) => setBinSearchTerm(e.target.value)}
              onSearch={() => selectedWarehouseId && void fetchBins(selectedWarehouseId)}
              style={{ width: 240 }}
            />
          </Space>
        </div>
        <Table
          rowKey="id"
          dataSource={filteredBins}
          columns={binColumns}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: selectedWarehouse ? t('inventory.binEmpty') : t('inventory.binSelectWarehouseFirst') }}
        />
      </Card>

      <SimpleModal
        title={editingWarehouse ? t('inventory.editWarehouse') : t('inventory.addWarehouse')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          warehouseForm.resetFields();
          setEditingWarehouse(null);
        }}
        footer={null}
        width={600}
        height={600}
      >
        <Form form={warehouseForm} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label={t('common.code')}
            name="code"
            rules={[{ required: true, message: t('inventory.warehouseCodeRequired') }]}
          >
            <Input placeholder={t('inventory.warehouseCodePlaceholder')} disabled={!!editingWarehouse} />
          </Form.Item>
          <Form.Item
            label={t('common.name')}
            name="name"
            rules={[{ required: true, message: t('inventory.warehouseNameRequired') }]}
          >
            <Input placeholder={t('inventory.warehouseNamePlaceholder')} />
          </Form.Item>
          <Form.Item label={t('common.type')} name="type" initialValue="raw_material">
            <Select>
              <Select.Option value="raw_material">{t('inventory.warehouseTypes.rawMaterial')}</Select.Option>
              <Select.Option value="finished">{t('inventory.warehouseTypes.finished')}</Select.Option>
              <Select.Option value="semi_finished">{t('inventory.warehouseTypes.semiFinished')}</Select.Option>
              <Select.Option value="return">{t('inventory.warehouseTypes.return')}</Select.Option>
              <Select.Option value="scrap">{t('inventory.warehouseTypes.scrap')}</Select.Option>
              <Select.Option value="other">{t('inventory.warehouseTypes.other')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label={t('common.location')} name="location">
            <Input placeholder={t('inventory.warehouseLocationPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('common.manager')} name="manager_id">
            <Select placeholder={t('inventory.managerPlaceholder')}>
              {employees.map((e) => (
                <Select.Option key={e.id} value={e.id}>{e.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label={t('common.allowNegativeStock')} name="is_negative_stock_allowed" valuePropName="checked" initialValue={false}>
            <Checkbox />
          </Form.Item>
          <Form.Item label={t('common.status')} name="status" initialValue="active">
            <Select>
              <Select.Option value="active">{t('common.enabled')}</Select.Option>
              <Select.Option value="inactive">{t('common.disabled')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item style={{ textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
              <Button type="primary" htmlType="submit">
                {t('common.save')}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </SimpleModal>

      <SimpleModal
        title={editingBin ? t('inventory.editBin') : t('inventory.addBin')}
        open={binModalOpen}
        onCancel={() => {
          setBinModalOpen(false);
          binForm.resetFields();
          setEditingBin(null);
        }}
        onOk={() => binForm.submit()}
        destroyOnClose
      >
        <Form form={binForm} layout="vertical" onFinish={handleBinSubmit} style={{ marginTop: 16 }}>
          <Form.Item name="warehouse_id" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            label={t('common.code')}
            name="code"
            rules={[{ required: true, message: t('inventory.binCodeRequired') }]}
          >
            <Input placeholder={t('inventory.binCodePlaceholder')} />
          </Form.Item>
          <Form.Item
            label={t('common.name')}
            name="name"
            rules={[{ required: true, message: t('inventory.binNameRequired') }]}
          >
            <Input placeholder={t('inventory.binNamePlaceholder')} />
          </Form.Item>
          <Form.Item label={t('common.location')} name="location">
            <Input placeholder={t('inventory.binLocationPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('common.sortOrder')} name="sort_order" initialValue={0}>
            <Input />
          </Form.Item>
          <Form.Item label={t('common.status')} name="status" initialValue="active">
            <Select>
              <Select.Option value="active">{t('common.enabled')}</Select.Option>
              <Select.Option value="inactive">{t('common.disabled')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
