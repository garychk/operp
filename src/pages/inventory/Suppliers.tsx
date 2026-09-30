import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Tag, Modal, Form, Select, Space, message, Row, Col, InputNumber } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { useTranslation } from 'react-i18next';
import type { Tables } from '../../utils/supabase';
import { SupaModal } from '../../components/SupaModal';
import { SuperTable } from '../../components/SuperTable';

type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];

const { Option } = Select;
const supplierTable = 'erp_suppliers_s_539dcf81_b';

export function Suppliers() {
  const { t } = useTranslation();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchSuppliers();
  }, []);

  const fetchSuppliers = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(supplierTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setSuppliers(data || []);
    } catch (error) {
      console.error('Error fetching suppliers:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingSupplier) {
        await logWithTiming(t('suppliers.updateAction'), 'UPDATE', async () => {
          const { error } = await supabase
            .from(supplierTable)
            .update(values)
            .eq('id', editingSupplier.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        const { error } = await supabase
          .from(supplierTable)
          .insert([values]);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingSupplier(null);
      fetchSuppliers();
    } catch (error) {
      console.error('Error saving supplier:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: Supplier) => {
    setEditingSupplier(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('suppliers.deleteConfirm'),
      onOk: async () => {
        try {
          await logWithTiming(t('suppliers.deleteAction'), 'DELETE', async () => {
            const { error } = await supabase
              .from(supplierTable)
            .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success(t('common.deleteSuccess'));
          fetchSuppliers();
        } catch (error) {
          console.error('Error deleting supplier:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingSupplier(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const filteredSuppliers = suppliers.filter(
    (s) =>
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const typeLabels: Record<string, string> = {
    manufacturer: 'suppliers.typeOptions.manufacturer',
    distributor: 'suppliers.typeOptions.distributor',
    retailer: 'suppliers.typeOptions.retailer',
    service: 'suppliers.typeOptions.service',
    other: 'suppliers.typeOptions.other',
  };

  const levelLabels: Record<string, string> = {
    strategic: 'suppliers.levelOptions.strategic',
    preferred: 'suppliers.levelOptions.preferred',
    normal: 'suppliers.levelOptions.normal',
    potential: 'suppliers.levelOptions.potential',
  };

  const columns = [
    {
      title: t('suppliers.code'),
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: t('suppliers.name'),
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: t('common.type'),
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => (typeLabels[type] ? t(typeLabels[type]) : type),
    },
    {
      title: t('suppliers.level'),
      dataIndex: 'level',
      key: 'level',
      render: (level: string) => (levelLabels[level] ? t(levelLabels[level]) : level),
    },
    {
      title: t('suppliers.contactName'),
      dataIndex: 'contact_name',
      key: 'contact_name',
      render: (text: string) => text || '-',
    },
    {
      title: t('suppliers.contactPhone'),
      dataIndex: 'contact_phone',
      key: 'contact_phone',
      render: (text: string) => text || '-',
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? t('common.enabled') : t('suppliers.inactive')}
        </Tag>
      ),
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: Supplier) => (
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
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredSuppliers}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="suppliers"
        headerTitle={t('suppliers.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('suppliers.addSupplier')}</Button>
            <Input.Search
              allowClear
              placeholder={t('suppliers.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchSuppliers}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SupaModal
        title={editingSupplier ? t('suppliers.editSupplier') : t('suppliers.addSupplier')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingSupplier(null);
        }}
        width={1000}
        height={500}
        headerPanelTitle={t('suppliers.headerPanelTitle')}
        historyTable={supplierTable}
        historyRecordId={editingSupplier?.id}
        form={form}
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ padding: "0 16px 0 0" }}>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label={t('suppliers.code')}
                name="code"
                rules={[{ required: true, message: t('suppliers.codeRequired') }]}
              >
                <Input placeholder={t('suppliers.codePlaceholder')} disabled={!!editingSupplier} />
              </Form.Item>
              <Form.Item
                label={t('suppliers.name')}
                name="name"
                rules={[{ required: true, message: t('suppliers.nameRequired') }]}
              >
                <Input placeholder={t('suppliers.namePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('suppliers.shortName')} name="short_name">
                <Input placeholder={t('suppliers.shortNamePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('common.type')} name="type" initialValue="manufacturer">
                <Select>
                  <Option value="manufacturer">{t('suppliers.typeOptions.manufacturer')}</Option>
                  <Option value="distributor">{t('suppliers.typeOptions.distributor')}</Option>
                  <Option value="retailer">{t('suppliers.typeOptions.retailer')}</Option>
                  <Option value="service">{t('suppliers.typeOptions.service')}</Option>
                  <Option value="other">{t('suppliers.typeOptions.other')}</Option>
                </Select>
              </Form.Item>
              <Form.Item label={t('suppliers.level')} name="level" initialValue="normal">
                <Select>
                  <Option value="strategic">{t('suppliers.levelOptions.strategic')}</Option>
                  <Option value="preferred">{t('suppliers.levelOptions.preferred')}</Option>
                  <Option value="normal">{t('suppliers.levelOptions.normal')}</Option>
                  <Option value="potential">{t('suppliers.levelOptions.potential')}</Option>
                </Select>
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('suppliers.contactName')} name="contact_name">
                <Input placeholder={t('suppliers.contactNamePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('suppliers.contactPhone')} name="contact_phone">
                <Input placeholder={t('suppliers.contactPhonePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('suppliers.address')} name="address">
                <Input placeholder={t('suppliers.addressPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('suppliers.taxNo')} name="tax_no">
                <Input placeholder={t('suppliers.taxNoPlaceholder')} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('suppliers.bankName')} name="bank_name">
                <Input placeholder={t('suppliers.bankNamePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('suppliers.bankAccount')} name="bank_account">
                <Input placeholder={t('suppliers.bankAccountPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('suppliers.creditLimit')} name="credit_limit" initialValue={0}>
                <InputNumber placeholder={t('suppliers.creditLimitPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('common.status')} name="status" initialValue="active">
                <Select>
                  <Option value="active">{t('common.enabled')}</Option>
                  <Option value="inactive">{t('suppliers.inactive')}</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
      />
    </div>
  );
}
