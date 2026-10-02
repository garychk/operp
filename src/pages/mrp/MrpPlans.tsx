import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Tag, Modal, Form, Select, Space, message, DatePicker, Alert } from 'antd';
import { PlusOutlined, DeleteOutlined, EyeOutlined, PlayCircleOutlined, FileTextOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { nextDocumentNo } from '../../utils/documentNaming';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import dayjs from 'dayjs';
import SimpleModal from '../../components/SimpleModal';
import { useAuth } from '../../contexts/AuthContext';

type MrpPlan = Tables['erp_mrp_plans_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;
const mrpPlanTable = 'erp_mrp_plans_s_539dcf81_b';

/**
 * MRP 运算走 ai-server（service_role + 应用层租户过滤，RLS 对它无效）。
 * VITE_AI_SERVER_URL 约定与 AIChatPanel 一致（…/api/ai 结尾），这里换算出 /api/mrp 基址。
 */
const resolveMrpBaseUrl = () => {
  const explicitUrl = import.meta.env.VITE_AI_SERVER_URL;
  if (explicitUrl) {
    return explicitUrl.replace(/\/$/, '').replace(/\/api\/ai$/, '') + '/api/mrp';
  }
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3001/api/mrp';
  }
  return '/api/mrp';
};

interface MrpRunResponse {
  ok: boolean;
  error?: string;
  plan_no?: string;
  report?: string;
  report_generated_by?: 'llm' | 'fallback';
  report_error?: string | null;
}

export function MrpPlans() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [plans, setPlans] = useState<MrpPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [runningPlanId, setRunningPlanId] = useState<number | null>(null);
  const [reportView, setReportView] = useState<{
    open: boolean;
    planNo: string;
    report: string;
    generatedBy: 'llm' | 'fallback';
    llmError: string | null;
  } | null>(null);
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

  const handleRunMrp = async (record: MrpPlan) => {
    if (!user?.profile.id || !user?.tenantId) {
      message.error(t('auth.noTenantAssigned'));
      return;
    }
    Modal.confirm({
      title: t('mrp.plans.confirmRun'),
      content: t('mrp.plans.confirmRunContent'),
      onOk: async () => {
        setRunningPlanId(record.id);
        try {
          const response = await fetch(`${resolveMrpBaseUrl()}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              user_id: user.profile.id,
              tenant_id: user.tenantId,
              plan_id: record.id,
            }),
          });
          const data = (await response.json()) as MrpRunResponse;
          if (!response.ok || !data.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          message.success(t('mrp.plans.runSuccess'));
          setReportView({
            open: true,
            planNo: data.plan_no || record.plan_no,
            report: data.report || '',
            generatedBy: data.report_generated_by === 'llm' ? 'llm' : 'fallback',
            llmError: data.report_error ?? null,
          });
          fetchPlans();
        } catch (error) {
          console.error('Error running MRP:', error);
          message.error(`${t('mrp.plans.runFailed')}：${(error as Error).message}`);
        } finally {
          setRunningPlanId(null);
        }
      },
    });
  };

  const handleViewReport = async (record: MrpPlan) => {
    if (!user?.profile.id || !user?.tenantId) {
      message.error(t('auth.noTenantAssigned'));
      return;
    }
    try {
      const params = new URLSearchParams({
        user_id: String(user.profile.id),
        tenant_id: String(user.tenantId),
      });
      const response = await fetch(
        `${resolveMrpBaseUrl()}/report/${record.id}?${params.toString()}`,
      );
      const data = (await response.json()) as { ok: boolean; error?: string; report?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setReportView({
        open: true,
        planNo: record.plan_no,
        report: data.report || '',
        generatedBy: 'llm',
        llmError: null,
      });
    } catch (error) {
      console.error('Error fetching MRP report:', error);
      message.error(`${t('mrp.plans.reportFetchFailed')}：${(error as Error).message}`);
    }
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
    failed: { text: t('mrp.plans.statusFailed'), color: 'error' },
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
          {(record.status === 'draft' || record.status === 'failed') && (
            <Button
              type="text"
              icon={<PlayCircleOutlined />}
              loading={runningPlanId === record.id}
              onClick={() => handleRunMrp(record)}
            >
              {t('mrp.plans.run')}
            </Button>
          )}
          {record.analysis_report && (
            <Button
              type="text"
              icon={<FileTextOutlined />}
              onClick={() => handleViewReport(record)}
            >
              {t('mrp.plans.reportButton')}
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

      <Modal
        title={`${t('mrp.plans.reportTitle')} - ${reportView?.planNo ?? ''}`}
        open={reportView?.open ?? false}
        onCancel={() => setReportView(null)}
        footer={[
          <Button key="close" onClick={() => setReportView(null)}>
            {t('common.close')}
          </Button>,
        ]}
        width={720}
      >
        {reportView?.generatedBy === 'fallback' && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('mrp.plans.reportFromFallback')}
            description={reportView.llmError || undefined}
          />
        )}
        <div style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflowY: 'auto' }}>
          {reportView?.report || t('mrp.plans.reportEmpty')}
        </div>
      </Modal>
    </div>
  );
}
