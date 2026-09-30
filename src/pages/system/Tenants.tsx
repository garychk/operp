import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, Button, Form, Input, Select, Space, message, Card, Tag } from 'antd';
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import SimpleModal from '../../components/SimpleModal';
import { useAuth } from '../../contexts/AuthContext';

interface Tenant {
  id: number;
  code: string;
  name: string;
  status: string;
  remark: string | null;
  created_at: string | null;
}

export function Tenants() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  // deploy_41 给 sys_tenants 的策略：只有 super_admin 能新建/修改租户。
  // 普通管理员只能看到自己所属的那一条，这里直接把写操作收掉，
  // 免得点了之后被 RLS 静默拒绝、看不到任何反馈。
  const canManage = Boolean(currentUser?.isSuperAdmin);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [form] = Form.useForm();

  const fetchTenants = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('sys_tenants')
        .select('id, code, name, status, remark, created_at')
        .eq('is_deleted', 'n')
        .order('id', { ascending: true });

      if (error) throw error;
      setTenants(data || []);
    } catch (error) {
      message.error(t('tenants.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  const handleAdd = () => {
    setEditingTenant(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record: Tenant) => {
    setEditingTenant(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleSave = async (values: any) => {
    try {
      if (editingTenant) {
        await logWithTiming(t('tenants.logUpdate'), 'UPDATE', async () => {
          const { error } = await supabase
            .from('sys_tenants')
            .update({ ...values, updated_at: new Date().toISOString() })
            .eq('id', editingTenant.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming(t('tenants.logCreate'), 'INSERT', async () => {
          const { error } = await supabase
            .from('sys_tenants')
            .insert([{ ...values, status: values.status ?? '1', is_deleted: 'n' }]);
          if (error) throw error;
        });
        // 建租户不会自动带出管理员：管理员账号要在「用户管理」里建（可指定本租户）。
        // 不提示的话，新租户会变成一个谁都进不去的空壳。
        message.success(t('tenants.createdNeedAdmin'));
      }
      setModalVisible(false);
      form.resetFields();
      setEditingTenant(null);
      fetchTenants();
    } catch (error: any) {
      // 唯一索引冲突是最常见的失败原因，直接把库里的原文带出来
      message.error(error?.message || t('tenants.saveFailed'));
    }
  };

  const handleToggleStatus = async (record: Tenant) => {
    try {
      const nextStatus = record.status === '1' ? '0' : '1';
      await logWithTiming(t('tenants.logToggle'), 'UPDATE', async () => {
        const { error } = await supabase
          .from('sys_tenants')
          .update({ status: nextStatus, updated_at: new Date().toISOString() })
          .eq('id', record.id);
        if (error) throw error;
      });
      message.success(nextStatus === '1' ? t('tenants.enabled') : t('tenants.disabled'));
      fetchTenants();
    } catch (error) {
      message.error(t('tenants.saveFailed'));
    }
  };

  const columns: ColumnsType<Tenant> = [
    {
      title: t('common.id'),
      dataIndex: 'id',
      width: 80,
    },
    {
      title: t('tenants.code'),
      dataIndex: 'code',
      width: 160,
    },
    {
      title: t('tenants.name'),
      dataIndex: 'name',
      width: 220,
    },
    {
      title: t('tenants.remark'),
      dataIndex: 'remark',
      ellipsis: true,
      render: (remark: string | null) => remark || '-',
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 100,
      render: (status) => (
        <Tag color={status === '1' ? 'success' : 'error'}>
          {status === '1' ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('tenants.createdAt'),
      dataIndex: 'created_at',
      width: 180,
      render: (value: string | null) => (value ? new Date(value).toLocaleString() : '-'),
    },
    {
      title: t('common.actions'),
      width: 180,
      render: (_, record) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            disabled={!canManage}
            onClick={() => handleEdit(record)}
          >
            {t('common.edit')}
          </Button>
          <Button
            type="link"
            size="small"
            disabled={!canManage}
            onClick={() => handleToggleStatus(record)}
          >
            {record.status === '1' ? t('common.disabled') : t('common.enabled')}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={t('tenants.title')}
      variant='borderless'
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={!canManage}
          onClick={handleAdd}
        >
          {t('tenants.add')}
        </Button>
      }
    >
      {!canManage && (
        <div style={{ marginBottom: 16, fontSize: 12, color: '#8c8c8c' }}>
          {t('tenants.readonlyHint')}
        </div>
      )}
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={tenants}
        pagination={false}
      />
      <SimpleModal
        title={editingTenant ? t('tenants.edit') : t('tenants.add')}
        open={modalVisible}
        onCancel={() => {
          setModalVisible(false);
          form.resetFields();
          setEditingTenant(null);
        }}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="code"
            label={t('tenants.code')}
            rules={[{ required: true, message: t('tenants.codeRequired') }]}
          >
            <Input disabled={!!editingTenant} placeholder={t('tenants.codePlaceholder')} />
          </Form.Item>
          <Form.Item
            name="name"
            label={t('tenants.name')}
            rules={[{ required: true, message: t('tenants.nameRequired') }]}
          >
            <Input placeholder={t('tenants.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="remark" label={t('tenants.remark')}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="status" label={t('common.status')} initialValue="1">
            <Select>
              <Select.Option value="1">{t('common.enabled')}</Select.Option>
              <Select.Option value="0">{t('common.disabled')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </SimpleModal>
    </Card>
  );
}
