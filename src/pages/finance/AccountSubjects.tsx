import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Tag, Modal, Form, Select, Space, message } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { useTranslation } from 'react-i18next';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';

type AccountSubject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];

const { Option } = Select;

const accountSubjectTable = 'erp_account_subjects_s_539dcf81_b';

export function AccountSubjects() {
  const { t } = useTranslation();
  const [subjects, setSubjects] = useState<AccountSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSubject, setEditingSubject] = useState<AccountSubject | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchSubjects();
  }, []);

  const fetchSubjects = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(accountSubjectTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('code');

      if (error) throw error;
      setSubjects(data || []);
    } catch (error) {
      console.error('Error fetching subjects:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingSubject) {
        const { error } = await supabase
          .from(accountSubjectTable)
          .update(values)
          .eq('id', editingSubject.id);
        if (error) throw error;
        message.success(t('common.updateSuccess'));
      } else {
        const { error } = await supabase
          .from(accountSubjectTable)
          .insert([values]);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      setEditingSubject(null);
      form.resetFields();
      fetchSubjects();
    } catch (error) {
      console.error('Error saving subject:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('accountSubjects.deleteConfirm'),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(accountSubjectTable)
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success(t('common.deleteSuccess'));
          fetchSubjects();
        } catch (error) {
          console.error('Error deleting subject:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleEdit = (subject: AccountSubject) => {
    setEditingSubject(subject);
    form.setFieldsValue({
      code: subject.code,
      name: subject.name,
      category: subject.category,
      direction: subject.direction || 'debit',
      parent_id: subject.parent_id,
    });
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingSubject(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const filteredSubjects = subjects.filter(
    (s) =>
      s.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const categoryKeys: Record<string, string> = {
    asset: 'accountSubjects.assetCategory',
    liability: 'accountSubjects.liabilityCategory',
    equity: 'accountSubjects.equityCategory',
    revenue: 'accountSubjects.revenueCategory',
    expense: 'accountSubjects.expenseCategory',
  };

  const columns = [
    {
      title: t('accountSubjects.code'),
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: t('accountSubjects.name'),
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: t('accountSubjects.category'),
      dataIndex: 'category',
      key: 'category',
      render: (category: string) => t(categoryKeys[category] || category),
    },
    {
      title: t('accountSubjects.direction'),
      dataIndex: 'direction',
      key: 'direction',
      render: (direction: string) => (direction === 'debit' ? t('accountSubjects.debit') : t('accountSubjects.credit')),
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
      render: (_: any, record: AccountSubject) => (
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
        dataSource={filteredSubjects}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="account-subjects"
        headerTitle={t('accountSubjects.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('accountSubjects.addSubject')}</Button>
            <Input.Search
              allowClear
              placeholder={t('accountSubjects.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchSubjects}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <Modal
        title={editingSubject ? t('accountSubjects.editSubject') : t('accountSubjects.addSubject')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingSubject(null);
          form.resetFields();
        }}
        footer={<Space>
              <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
              <Button type="primary" onClick={() => form.submit()}>
                {t('common.save')}
              </Button>
            </Space>}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ marginTop: 16 }}>
          <Form.Item
            label={t('accountSubjects.code')}
            name="code"
            rules={[{ required: true, message: t('accountSubjects.codeRequired') }]}
          >
            <Input placeholder={t('accountSubjects.codePlaceholder')} />
          </Form.Item>
          <Form.Item
            label={t('accountSubjects.name')}
            name="name"
            rules={[{ required: true, message: t('accountSubjects.nameRequired') }]}
          >
            <Input placeholder={t('accountSubjects.namePlaceholder')} />
          </Form.Item>
          <Form.Item
            label={t('accountSubjects.subjectCategory')}
            name="category"
            rules={[{ required: true, message: t('accountSubjects.categoryRequired') }]}
          >
            <Select placeholder={t('accountSubjects.selectPlaceholder')}>
              <Option value="asset">{t('accountSubjects.assetCategory')}</Option>
              <Option value="liability">{t('accountSubjects.liabilityCategory')}</Option>
              <Option value="equity">{t('accountSubjects.equityCategory')}</Option>
              <Option value="revenue">{t('accountSubjects.revenueCategory')}</Option>
              <Option value="expense">{t('accountSubjects.expenseCategory')}</Option>
            </Select>
          </Form.Item>
          <Form.Item label={t('accountSubjects.direction')} name="direction">
            <Select>
              <Option value="debit">{t('accountSubjects.debit')}</Option>
              <Option value="credit">{t('accountSubjects.credit')}</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
