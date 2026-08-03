import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Tag, Modal, Form, Select, Space, message, InputNumber, Row, Col, DatePicker } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import type { Tables } from '../../utils/supabase';
import dayjs from 'dayjs';
import { SuperTable } from '../../components/SuperTable';
import { useTranslation } from 'react-i18next';

type FixedAsset = Tables['erp_fixed_assets_s_539dcf81_b']['Row'];
type AssetCategory = Tables['erp_asset_categories_s_539dcf81_b']['Row'];

const { Option } = Select;
const fixedAssetTable = 'erp_fixed_assets_s_539dcf81_b';

export function FixedAssets() {
  const { t } = useTranslation();
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<FixedAsset | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchAssets();
    fetchCategories();
  }, []);

  const fetchAssets = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(fixedAssetTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setAssets(data || []);
    } catch (error) {
      console.error('Error fetching assets:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_asset_categories_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n');
      if (error) throw error;
      setCategories(data || []);
    } catch (error) {
      console.error('Error fetching categories:', error);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingAsset) {
        await logWithTiming(t('fixedAssets.log.updateAction'), 'UPDATE', async () => {
          const { error } = await supabase
            .from(fixedAssetTable)
            .update(values)
            .eq('id', editingAsset.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming(t('fixedAssets.log.createAction'), 'INSERT', async () => {
          const { error } = await supabase
            .from(fixedAssetTable)
            .insert([{
              ...values,
              accumulated_depreciation: 0,
              net_value: values.original_value,
            }]);
          if (error) throw error;
        });
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingAsset(null);
      fetchAssets();
    } catch (error) {
      console.error('Error saving asset:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: FixedAsset) => {
    setEditingAsset(record);
    form.setFieldsValue({
      ...record,
      purchase_date: dayjs(record.purchase_date),
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('fixedAssets.confirm.deleteContent'),
      onOk: async () => {
        try {
          await logWithTiming(t('fixedAssets.log.deleteAction'), 'DELETE', async () => {
            const { error } = await supabase
              .from(fixedAssetTable)
            .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success(t('common.deleteSuccess'));
          fetchAssets();
        } catch (error) {
          console.error('Error deleting asset:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingAsset(null);
    form.setFieldsValue({
      asset_no: '',
      asset_name: '',
      category_id: undefined,
      model: '',
      quantity: 1,
      unit: 'PCS',
      purchase_date: dayjs(new Date()),
      purchase_price: 0,
      original_value: 0,
      depreciation_method: 'straight_line',
      useful_life_months: 60,
      residual_rate: 5,
      location: '',
      status: 'in_use',
    });
    setIsModalOpen(true);
  };

  const getCategoryName = (categoryId: number | null) => {
    const category = categories.find((c) => c.id === categoryId);
    return category?.name || '-';
  };

  const filteredAssets = assets.filter(
    (a) =>
      a.asset_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.asset_name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { textKey: string; color: string }> = {
    in_use: { textKey: 'fixedAssets.statusOptions.in_use', color: 'success' },
    idle: { textKey: 'fixedAssets.statusOptions.idle', color: 'warning' },
    scrapped: { textKey: 'fixedAssets.statusOptions.scrapped', color: 'default' },
    transferred: { textKey: 'fixedAssets.statusOptions.transferred', color: 'processing' },
  };

  const columns = [
    {
      title: t('fixedAssets.assetNo'),
      dataIndex: 'asset_no',
      key: 'asset_no',
    },
    {
      title: t('fixedAssets.assetName'),
      dataIndex: 'asset_name',
      key: 'asset_name',
    },
    {
      title: t('fixedAssets.category'),
      dataIndex: 'category_id',
      key: 'category_id',
      render: (categoryId: number) => getCategoryName(categoryId),
    },
    {
      title: t('fixedAssets.purchaseDate'),
      dataIndex: 'purchase_date',
      key: 'purchase_date',
    },
    {
      title: t('fixedAssets.originalValue'),
      dataIndex: 'original_value',
      key: 'original_value',
      render: (value: number) => `¥${(value ?? 0).toLocaleString()}`,
    },
    {
      title: t('fixedAssets.netValue'),
      dataIndex: 'net_value',
      key: 'net_value',
      render: (value: number) => `¥${(value ?? 0).toLocaleString()}`,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { textKey: status, color: 'default' };
        return <Tag color={config.color}>{t(config.textKey)}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: FixedAsset) => (
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

  return (
    <div className="mainContent">
      <SuperTable
        columns={columns}
        dataSource={filteredAssets}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="fixed-assets"
        headerTitle={t('fixedAssets.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('fixedAssets.addAsset')}</Button>
            <Input.Search
              allowClear
              placeholder={t('fixedAssets.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchAssets}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <Modal
        title={editingAsset ? t('fixedAssets.editAsset') : t('fixedAssets.addAsset')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingAsset(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={() => form.submit()}>
            {t('common.save')}
          </Button>
        </Space>}
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('fixedAssets.assetNo')}
                name="asset_no"
                rules={[{ required: true, message: t('fixedAssets.assetNoRequired') }]}
              >
                <Input placeholder={t('fixedAssets.assetNoPlaceholder')} disabled={!!editingAsset} />
              </Form.Item>
              <Form.Item
                label={t('fixedAssets.assetName')}
                name="asset_name"
                rules={[{ required: true, message: t('fixedAssets.assetNameRequired') }]}
              >
                <Input placeholder={t('fixedAssets.assetNamePlaceholder')} />
              </Form.Item>
              <Form.Item
                label={t('fixedAssets.category')}
                name="category_id"
                rules={[{ required: true, message: t('fixedAssets.categoryRequired') }]}
              >
                <Select placeholder={t('fixedAssets.categoryPlaceholder')}>
                  {categories.map((c) => (
                    <Option key={c.id} value={c.id}>{c.name}</Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label={t('fixedAssets.model')} name="model">
                <Input placeholder={t('fixedAssets.modelPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('fixedAssets.quantity')} name="quantity" initialValue={1}>
                <InputNumber style={{ width: '100%' }} placeholder={t('fixedAssets.quantityPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('fixedAssets.unit')} name="unit" initialValue="台">
                <Input placeholder={t('fixedAssets.unitPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('fixedAssets.purchaseDate')} name="purchase_date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('fixedAssets.purchasePrice')} name="purchase_price" initialValue={0}>
                <InputNumber style={{ width: '100%' }} placeholder={t('fixedAssets.purchasePricePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('fixedAssets.originalValue')} name="original_value" initialValue={0}>
                <InputNumber style={{ width: '100%' }} placeholder={t('fixedAssets.originalValuePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('fixedAssets.depreciationMethod')} name="depreciation_method" initialValue="straight_line">
                <Select>
                  <Option value="straight_line">{t('fixedAssets.depreciationMethods.straight_line')}</Option>
                  <Option value="double_declining">{t('fixedAssets.depreciationMethods.double_declining')}</Option>
                  <Option value="sum_of_years">{t('fixedAssets.depreciationMethods.sum_of_years')}</Option>
                </Select>
              </Form.Item>
              <Form.Item label={t('fixedAssets.usefulLifeMonths')} name="useful_life_months" initialValue={60}>
                <InputNumber style={{ width: '100%' }} placeholder={t('fixedAssets.usefulLifeMonthsPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('fixedAssets.residualRate')} name="residual_rate" initialValue={5}>
                <InputNumber style={{ width: '100%' }} placeholder={t('fixedAssets.residualRatePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('fixedAssets.location')} name="location">
                <Input placeholder={t('fixedAssets.locationPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('common.status')} name="status" initialValue="in_use">
                <Select>
                  <Option value="in_use">{t('fixedAssets.statusOptions.in_use')}</Option>
                  <Option value="idle">{t('fixedAssets.statusOptions.idle')}</Option>
                  <Option value="scrapped">{t('fixedAssets.statusOptions.scrapped')}</Option>
                  <Option value="transferred">{t('fixedAssets.statusOptions.transferred')}</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}
