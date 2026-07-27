import { useEffect, useState } from 'react';
import { Button, Input, Table, Modal, Form, Select, Space, Card, message, InputNumber } from 'antd';
import { PlusOutlined, SearchOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { useTranslation } from 'react-i18next';

type AssetCategory = Tables['erp_asset_categories_s_539dcf81_b']['Row'];

const { Option } = Select;

export function AssetCategories() {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<AssetCategory | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_asset_categories_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('code');

      if (error) throw error;
      setCategories(data || []);
    } catch (error) {
      console.error('Error fetching categories:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingCategory) {
        const { error } = await supabase
          .from('erp_asset_categories_s_539dcf81_b')
          .update(values)
          .eq('id', editingCategory.id);
        if (error) throw error;
        message.success(t('common.updateSuccess'));
      } else {
        const { error } = await supabase
          .from('erp_asset_categories_s_539dcf81_b')
          .insert([values]);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      setEditingCategory(null);
      form.resetFields();
      fetchCategories();
    } catch (error) {
      console.error('Error saving category:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('assetCategories.confirm.deleteContent'),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from('erp_asset_categories_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success(t('common.deleteSuccess'));
          fetchCategories();
        } catch (error) {
          console.error('Error deleting category:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleEdit = (category: AssetCategory) => {
    setEditingCategory(category);
    form.setFieldsValue({
      code: category.code,
      name: category.name,
      parent_id: category.parent_id,
      depreciation_method: category.depreciation_method || 'straight_line',
      useful_life_months: category.useful_life_months || 60,
      residual_rate: category.residual_rate || 5,
      subject_id: category.subject_id,
    });
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingCategory(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const filteredCategories = categories.filter(
    (c) =>
      c.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getParentName = (parentId: number | null) => {
    if (!parentId) return '-';
    const parent = categories.find((c) => c.id === parentId);
    return parent?.name || '-';
  };

  const depreciationMethodLabels: Record<string, string> = {
    straight_line: 'assetCategories.depreciationMethods.straight_line',
    double_declining: 'assetCategories.depreciationMethods.double_declining',
    sum_of_years: 'assetCategories.depreciationMethods.sum_of_years',
  };

  const columns = [
    {
      title: t('assetCategories.code'),
      dataIndex: 'code',
      key: 'code',
    },
    {
      title: t('assetCategories.name'),
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: t('assetCategories.parentCategory'),
      dataIndex: 'parent_id',
      key: 'parent_id',
      render: (parentId: number | null) => getParentName(parentId),
    },
    {
      title: t('assetCategories.depreciationMethod'),
      dataIndex: 'depreciation_method',
      key: 'depreciation_method',
      render: (method: string | null) => depreciationMethodLabels[method || ''] ? t(depreciationMethodLabels[method || '']) : '-',
    },
    {
      title: t('assetCategories.usefulLifeMonths'),
      dataIndex: 'useful_life_months',
      key: 'useful_life_months',
      render: (months: number | null) => months || '-',
    },
    {
      title: t('assetCategories.residualRate'),
      dataIndex: 'residual_rate',
      key: 'residual_rate',
      render: (rate: number | null) => rate || '-',
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: AssetCategory) => (
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
    <Card className='mainContent' variant="borderless" title={t('assetCategories.title')} extra={<Space>
      <Input
        placeholder={t('assetCategories.searchPlaceholder')}
        prefix={<SearchOutlined />}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
      <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('assetCategories.addCategory')}</Button>
    </Space>}>

      <Table
        columns={columns}
        dataSource={filteredCategories}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={editingCategory ? t('assetCategories.editCategory') : t('assetCategories.addCategory')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingCategory(null);
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
            label={t('assetCategories.code')}
            name="code"
            rules={[{ required: true, message: t('assetCategories.codeRequired') }]}
          >
            <Input placeholder={t('assetCategories.codePlaceholder')} />
          </Form.Item>
          <Form.Item
            label={t('assetCategories.name')}
            name="name"
            rules={[{ required: true, message: t('assetCategories.nameRequired') }]}
          >
            <Input placeholder={t('assetCategories.namePlaceholder')} />
          </Form.Item>
          <Form.Item label={t('assetCategories.parentCategory')} name="parent_id">
            <Select placeholder={t('assetCategories.parentCategoryPlaceholder')}>
              <Option value={null}>{t('assetCategories.none')}</Option>
              {categories.filter((c) => c.id !== editingCategory?.id).map((c) => (
                <Option key={c.id} value={c.id}>{c.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label={t('assetCategories.depreciationMethod')} name="depreciation_method" initialValue="straight_line">
            <Select>
              <Option value="straight_line">{t('assetCategories.depreciationMethods.straight_line')}</Option>
              <Option value="double_declining">{t('assetCategories.depreciationMethods.double_declining')}</Option>
              <Option value="sum_of_years">{t('assetCategories.depreciationMethods.sum_of_years')}</Option>
            </Select>
          </Form.Item>
          <Form.Item label={t('assetCategories.usefulLifeMonths')} name="useful_life_months" initialValue={60}>
            <InputNumber style={{ width: '100%' }} placeholder={t('assetCategories.usefulLifeMonthsPlaceholder')} />
          </Form.Item>
          <Form.Item label={t('assetCategories.residualRate')} name="residual_rate" initialValue={5}>
            <InputNumber style={{ width: '100%' }} placeholder={t('assetCategories.residualRatePlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

