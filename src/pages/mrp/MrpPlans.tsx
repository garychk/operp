import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Tag, Modal, Form, Select, Space, message, DatePicker } from 'antd';
import { PlusOutlined, DeleteOutlined, EyeOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import dayjs from 'dayjs';
import SimpleModal from '../../components/SimpleModal';

type MrpPlan = Tables['erp_mrp_plans_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;
const mrpPlanTable = 'erp_mrp_plans_s_539dcf81_b';

export function MrpPlans() {
  const { t } = useTranslation();
  const [plans, setPlans] = useState<MrpPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchPlans();
  }, []);

  const fetchPlans = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(mrpPlanTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('plan_date', { ascending: false });

      if (error) throw error;
      setPlans(data || []);
    } catch (error) {
      console.error('Error fetching plans:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      const { error } = await supabase
        .from(mrpPlanTable)
        .insert([values]);
      if (error) throw error;
      message.success(t('common.createSuccess'));
      setIsModalOpen(false);
      form.resetFields();
      fetchPlans();
    } catch (error) {
      console.error('Error saving plan:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('mrp.plans.deleteConfirm'),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(mrpPlanTable)
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          message.success(t('common.deleteSuccess'));
          fetchPlans();
        } catch (error) {
          console.error('Error deleting plan:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleRunMrp = async (id: number) => {
    Modal.confirm({
      title: t('mrp.plans.confirmRun'),
      content: t('mrp.plans.confirmRunContent'),
      onOk: async () => {
        try {
          const { error } = await supabase
            .from(mrpPlanTable)
            .update({ status: 'running' })
            .eq('id', id);
          if (error) throw error;
          message.success(t('mrp.plans.runStarted'));
          fetchPlans();
        } catch (error) {
          console.error('Error running MRP:', error);
          message.error(t('mrp.plans.runFailed'));
        }
      },
    });
  };

  const handleAdd = async () => {
    let planNo: string;
    try {
      planNo = await nextDocumentNo('mrp_plan');
    } catch (error) {
      message.error(`${t('common.documentNoFailed')}：${(error as Error).message}`);
      return;
    }
    form.setFieldsValue({
      plan_no: planNo,
      plan_date: dayjs(new Date()),
      start_date: '',
      end_date: '',
      plan_type: 'master',
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const filteredPlans = plans.filter(
    (p) =>
      p.plan_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.remark && p.remark.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const typeLabels: Record<string, string> = {
    master: t('mrp.plans.typeMaster'),
    material: t('mrp.plans.typeMaterial'),
    capacity: t('mrp.plans.typeCapacity'),
    procurement: t('mrp.plans.typeProcurement'),
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: t('mrp.plans.statusDraft'), color: 'default' },
    running: { text: t('mrp.plans.statusRunning'), color: 'processing' },
    completed: { text: t('mrp.plans.statusCompleted'), color: 'success' },
    cancelled: { text: t('mrp.plans.statusCancelled'), color: 'error' },
  };

  const columns = [
    {
      title: t('mrp.plans.planNo'),
      dataIndex: 'plan_no',
      key: 'plan_no',
    },
    {
      title: t('mrp.plans.planDate'),
      dataIndex: 'plan_date',
      key: 'plan_date',
    },
    {
      title: t('mrp.plans.startDate'),
      dataIndex: 'start_date',
      key: 'start_date',
      render: (text: string) => text || '-',
    },
    {
      title: t('mrp.plans.endDate'),
      dataIndex: 'end_date',
      key: 'end_date',
      render: (text: string) => text || '-',
    },
    {
      title: t('common.type'),
      dataIndex: 'plan_type',
      key: 'plan_type',
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: MrpPlan) => (
        <Space size="middle">
          <Button type="text" icon={<EyeOutlined />}>
            {t('mrp.plans.view')}
          </Button>
          {record.status === 'draft' && (
            <Button type="text" icon={<PlayCircleOutlined />} onClick={() => handleRunMrp(record.id)}>
              {t('mrp.plans.run')}
            </Button>
          )}
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
        dataSource={filteredPlans}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="mrp-plans"
        headerTitle={t('mrp.plans.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('mrp.plans.add')}</Button>
            <Input.Search
              allowClear
              placeholder={t('mrp.plans.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchPlans}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SimpleModal
        title={t('mrp.plans.addTitle')}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
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
            label={t('mrp.plans.planNo')}
            name="plan_no"
            rules={[{ required: true, message: t('mrp.plans.planNoPrompt') }]}
          >
            <Input placeholder={t('mrp.plans.planNoPrompt')} />
          </Form.Item>
          <Form.Item label={t('mrp.plans.planType')} name="plan_type" initialValue="master">
            <Select>
              <Option value="master">{t('mrp.plans.typeMaster')}</Option>
              <Option value="material">{t('mrp.plans.typeMaterial')}</Option>
              <Option value="capacity">{t('mrp.plans.typeCapacity')}</Option>
              <Option value="procurement">{t('mrp.plans.typeProcurement')}</Option>
            </Select>
          </Form.Item>
          <Form.Item label={t('mrp.plans.planDate')} name="plan_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('mrp.plans.startDate')} name="start_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('mrp.plans.endDate')} name="end_date">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('mrp.plans.remark')} name="remark">
            <TextArea rows={3} placeholder={t('mrp.plans.remarkPrompt')} />
          </Form.Item>
          <Form.Item label={t('common.status')} name="status" initialValue="draft">
            <Select>
              <Option value="draft">{t('mrp.plans.statusDraft')}</Option>
              <Option value="running">{t('mrp.plans.statusRunning')}</Option>
              <Option value="completed">{t('mrp.plans.statusCompleted')}</Option>
            </Select>
          </Form.Item>
        </Form>
      </SimpleModal>
    </div>
  );
}
