import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Tag, Modal, Form, Select, Space, message, Row, Col, InputNumber } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '@/utils/supabase';
import { logWithTiming } from '@/utils/logger';
import { useTranslation } from 'react-i18next';
import type { Tables } from '@/utils/supabase';
import { SuperTable } from '@/components/SuperTable';
import SimpleModal from '@/components/SimpleModal';

type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];

const { Option } = Select;
const customerTable = 'erp_customers_s_539dcf81_b';

export function Customers() {
  const { t } = useTranslation();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchCustomers();
  }, []);

  const fetchCustomers = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(customerTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error fetching customers:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingCustomer) {
        await logWithTiming(t('customers.updateAction'), 'UPDATE', async () => {
          const { error } = await supabase
            .from(customerTable)
            .update(values)
            .eq('id', editingCustomer.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming(t('customers.createAction'), 'INSERT', async () => {
          const { error } = await supabase
            .from(customerTable)
            .insert([values]);
          if (error) throw error;
        });
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingCustomer(null);
      fetchCustomers();
    } catch (error) {
      console.error('Error saving customer:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: Customer) => {
    setEditingCustomer(record);
    form.setFieldsValue(record);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('customers.deleteConfirm'),
      onOk: async () => {
        try {
          await logWithTiming(t('customers.deleteAction'), 'DELETE', async () => {
            const { error } = await supabase
              .from(customerTable)
            .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success(t('common.deleteSuccess'));
          fetchCustomers();
        } catch (error) {
          console.error('Error deleting customer:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingCustomer(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.code.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const typeKeys: Record<string, string> = {
    enterprise: 'customers.typeOptions.enterprise',
    individual: 'customers.typeOptions.individual',
    government: 'customers.typeOptions.government',
    other: 'customers.typeOptions.other',
  };

  const levelKeys: Record<string, string> = {
    vip: 'customers.levelOptions.vip',
    important: 'customers.levelOptions.important',
    normal: 'customers.levelOptions.normal',
    potential: 'customers.levelOptions.potential',
  };

  const columns = [
    {
      title: t('customers.code'),
      dataIndex: 'code',
      key: 'code',
      width: 160,
    },
    {
      title: t('customers.name'),
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: t('customers.type'),
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (type: string) => (typeKeys[type] ? t(typeKeys[type]) : type),
    },
    {
      title: t('customers.level'),
      dataIndex: 'level',
      key: 'level',
      width: 120,
      render: (level: string) => (levelKeys[level] ? t(levelKeys[level]) : level),
    },
    {
      title: t('customers.contactName'),
      dataIndex: 'contact_name',
      key: 'contact_name',
      width: 160,
      render: (text: string) => text || '-',
    },
    {
      title: t('customers.contactPhone'),
      dataIndex: 'contact_phone',
      key: 'contact_phone',
      width: 160,
      render: (text: string) => text || '-',
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: string) => (
        <Tag color={status === 'active' ? 'success' : 'default'}>
          {status === 'active' ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('common.actions'),
      key: 'action',
      width: 120,
      render: (_: any, record: Customer) => (
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
        dataSource={filteredCustomers}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="customers"
        tableName={customerTable}
        headerTitle={t('customers.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        onDataChanged={fetchCustomers}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('customers.addCustomer')}</Button>
            <Input.Search
              allowClear
              placeholder={t('customers.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchCustomers}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={editingCustomer ? t('customers.editCustomer') : t('customers.addCustomer')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingCustomer(null);
        }}
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('customers.code')}
                name="code"
                rules={[{ required: true, message: t('customers.codeRequired') }]}
              >
                <Input placeholder={t('customers.codePlaceholder')} disabled={!!editingCustomer} />
              </Form.Item>
              <Form.Item
                label={t('customers.name')}
                name="name"
                rules={[{ required: true, message: t('customers.nameRequired') }]}
              >
                <Input placeholder={t('customers.namePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('customers.shortName')} name="short_name">
                <Input placeholder={t('customers.shortNamePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('customers.type')} name="type" initialValue="enterprise">
                <Select>
                  <Option value="enterprise">{t('customers.typeOptions.enterprise')}</Option>
                  <Option value="individual">{t('customers.typeOptions.individual')}</Option>
                  <Option value="government">{t('customers.typeOptions.government')}</Option>
                  <Option value="other">{t('customers.typeOptions.other')}</Option>
                </Select>
              </Form.Item>
              <Form.Item label={t('customers.level')} name="level" initialValue="normal">
                <Select>
                  <Option value="vip">{t('customers.levelOptions.vip')}</Option>
                  <Option value="important">{t('customers.levelOptions.important')}</Option>
                  <Option value="normal">{t('customers.levelOptions.normal')}</Option>
                  <Option value="potential">{t('customers.levelOptions.potential')}</Option>
                </Select>
              </Form.Item>
              <Form.Item label={t('customers.contactName')} name="contact_name">
                <Input placeholder={t('customers.contactNamePlaceholder')} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('customers.contactPhone')} name="contact_phone">
                <Input placeholder={t('customers.contactPhonePlaceholder')} />
              </Form.Item>
              <Form.Item label={t('customers.address')} name="address">
                <Input placeholder={t('customers.addressPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('customers.taxNo')} name="tax_no">
                <Input placeholder={t('customers.taxNoPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('customers.creditLimit')} name="credit_limit" initialValue={0}>
                <InputNumber placeholder={t('customers.creditLimitPlaceholder')} />
              </Form.Item>
              <Form.Item label={t('common.status')} name="status" initialValue="active">
                <Select>
                  <Option value="active">{t('common.enabled')}</Option>
                  <Option value="inactive">{t('common.disabled')}</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </SimpleModal>
    </div>
  );
}
