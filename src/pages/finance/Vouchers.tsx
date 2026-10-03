import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, message, InputNumber, DatePicker, Row, Col, Switch } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, AccountBookOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SupaModal } from '../../components/SupaModal';
import { logWithTiming } from '../../utils/logger';
import { runBusinessAction } from '../../utils/businessEngine';
import { nextDocumentNo } from '../../utils/documentNaming';
import { useAuth } from '../../contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import dayjs from 'dayjs';
import { SuperTable } from '../../components/SuperTable';
import { formatMoney } from '../../utils/money';
import { MoneyInput } from '../../components/MoneyInput';

type Voucher = Tables['erp_vouchers_s_539dcf81_b']['Row'];
type VoucherDetail = Tables['erp_voucher_details_s_539dcf81_b']['Row'];
type AccountSubject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;
const voucherTable = 'erp_vouchers_s_539dcf81_b';
const voucherDetailTable = 'erp_voucher_details_s_539dcf81_b';

export function Vouchers() {
  const { t } = useTranslation();
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [accountSubjects, setAccountSubjects] = useState<AccountSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null);
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [details, setDetails] = useState<VoucherDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<VoucherDetail | null>(null);
  const [isDebit, setIsDebit] = useState(true);
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();
  const { user } = useAuth();

  useEffect(() => {
    fetchVouchers();
    fetchAccountSubjects();
  }, []);

  const fetchVouchers = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(voucherTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('voucher_date', { ascending: false });

      if (error) throw error;
      setVouchers(data || []);
    } catch (error) {
      console.error('Error fetching vouchers:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchAccountSubjects = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_account_subjects_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setAccountSubjects(data || []);
    } catch (error) {
      console.error('Error fetching account subjects:', error);
    }
  };

  const fetchDetails = async (voucherId: number) => {
    try {
      const { data, error } = await supabase
        .from(voucherDetailTable)
        .select('*')
        .eq('is_deleted', 'n')
        .eq('voucher_id', voucherId)
        .order('line_no');
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error('Error fetching details:', error);
      message.error(t('vouchers.messages.fetchDetailsFailed'));
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingVoucher) {
        await logWithTiming(t('vouchers.log.updateAction'), 'UPDATE', async () => {
          const { error } = await supabase
            .from(voucherTable)
            .update(values)
            .eq('id', editingVoucher.id);
          if (error) throw error;
        }, { table: voucherTable, recordId: editingVoucher.id });
        message.success(t('common.updateSuccess'));
      } else {
        const logParams: { table: string; recordId?: number } = {
          table: voucherTable,
        };
        const data = await logWithTiming(t('vouchers.log.createAction'), 'INSERT', async () => {
          const { data, error } = await supabase
            .from(voucherTable)
            .insert([values])
            .select()
            .single();
          if (error) throw error;
          logParams.recordId = data.id;
          return data;
        }, logParams);
        message.success(t('common.createSuccess'));
        setSelectedVoucher(data);
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingVoucher(null);
      fetchVouchers();
    } catch (error) {
      console.error('Error saving voucher:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedVoucher && !editingVoucher) {
        message.error(t('vouchers.messages.pleaseSelectVoucher'));
        return;
      }

      const voucherId = selectedVoucher?.id || editingVoucher?.id;
      if (!voucherId) {
        message.error(t('vouchers.messages.pleaseSaveVoucherFirst'));
        return;
      }

      if (editingDetail) {
        await supabase
          .from(voucherDetailTable)
          .update(values)
          .eq('id', editingDetail.id);
        message.success(t('common.updateSuccess'));
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map(d => d.line_no)) : 0;
        values.line_no = maxLineNo + 1;
        values.voucher_id = voucherId;
        values.debit_amount = values.debit_amount || 0;
        values.credit_amount = values.credit_amount || 0;
        values.is_deleted = 'n';

        const { error } = await supabase
          .from(voucherDetailTable)
          .insert([values]);
        if (error) throw error;
        message.success(t('common.createSuccess'));
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(voucherId);
      updateVoucherTotal(voucherId);
    } catch (error) {
      console.error('Error saving detail:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const updateVoucherTotal = async (voucherId: number) => {
    try {
      const { data, error } = await supabase
        .from(voucherDetailTable)
        .select('debit_amount, credit_amount')
        .eq('is_deleted', 'n')
        .eq('voucher_id', voucherId);
      if (error) throw error;

      const totalDebit = data?.reduce((sum, d) => sum + (d.debit_amount || 0), 0) || 0;
      const totalCredit = data?.reduce((sum, d) => sum + (d.credit_amount || 0), 0) || 0;
      const totalAmount = Math.max(totalDebit, totalCredit);

      await supabase
        .from(voucherTable)
        .update({ total_amount: totalAmount })
        .eq('id', voucherId);

      fetchVouchers();
    } catch (error) {
      console.error('Error updating voucher total:', error);
    }
  };

  const handleEdit = async (record: Voucher) => {
    setEditingVoucher(record);
    const formValues = { ...record };
    if (formValues.voucher_date) {
      formValues.voucher_date = dayjs(formValues.voucher_date);
    }
    form.setFieldsValue(formValues);
    setSelectedVoucher(record);
    await fetchDetails(record.id);
    setIsModalOpen(true);
  };

  const businessUser = { id: user?.profile.id, username: user?.profile.username };

  const handlePost = (record: Voucher) => {
    Modal.confirm({
      title: t('vouchers.confirm.postTitle'),
      content: t('vouchers.confirm.postContent'),
      onOk: async () => {
        try {
          await runBusinessAction({ action: 'post', documentType: 'voucher', documentId: record.id, user: businessUser });
          message.success(t('vouchers.messages.postSuccess'));
          fetchVouchers();
        } catch (error: any) {
          console.error('Error posting voucher:', error);
          message.error(error?.message || t('vouchers.messages.postFailed'));
        }
      },
    });
  };

  const handleReversePost = (record: Voucher) => {
    Modal.confirm({
      title: t('vouchers.confirm.reversePostTitle'),
      content: t('vouchers.confirm.reversePostContent'),
      onOk: async () => {
        try {
          await runBusinessAction({ action: 'reverse_post', documentType: 'voucher', documentId: record.id, user: businessUser });
          message.success(t('vouchers.messages.reversePostSuccess'));
          fetchVouchers();
        } catch (error: any) {
          console.error('Error reversing voucher:', error);
          message.error(error?.message || t('vouchers.messages.reversePostFailed'));
        }
      },
    });
  };
  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('vouchers.confirm.deleteContent'),
      onOk: async () => {
        try {
          await logWithTiming(t('vouchers.log.deleteAction'), 'DELETE', async () => {
            const { error } = await supabase
              .from(voucherTable)
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
            const { error: detailError } = await supabase
              .from(voucherDetailTable)
              .update({ is_deleted: 'y' })
              .eq('voucher_id', id);
            if (detailError) throw detailError;
          }, { table: voucherTable, recordId: id });
          message.success(t('common.deleteSuccess'));
          fetchVouchers();
        } catch (error) {
          console.error('Error deleting voucher:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = async () => {
    let voucherNo: string;
    try {
      voucherNo = await nextDocumentNo('voucher');
    } catch (error) {
      message.error(`${t('common.documentNoFailed')}：${(error as Error).message}`);
      return;
    }
    setEditingVoucher(null);
    setSelectedVoucher(null);
    setDetails([]);
    form.setFieldsValue({
      voucher_no: voucherNo,
      voucher_date: dayjs(new Date()),
      type: 'general',
      total_amount: 0,
      remark: '',
      status: 'draft',
    });
    setIsModalOpen(true);
  };

  const handleAddDetail = () => {
    setEditingDetail(null);
    detailForm.setFieldsValue({
      subject_id: undefined,
      summary: '',
      debit_amount: 0,
      credit_amount: 0,
      auxiliary_type: '',
      auxiliary_id: undefined,
    });
    setIsDetailModalOpen(true);
  };

  const handleEditDetail = (record: VoucherDetail) => {
    setEditingDetail(record);
    if(record.debit_amount){
      setIsDebit(record.debit_amount > 0);
    }    
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('vouchers.confirm.deleteDetailContent'),
      onOk: async () => {
        try {
          await supabase
            .from(voucherDetailTable)
            .update({ is_deleted: 'y' })
            .eq('id', id);
          message.success(t('common.deleteSuccess'));
          const voucherId = selectedVoucher?.id || editingVoucher?.id;
          if (voucherId) {
            fetchDetails(voucherId);
            updateVoucherTotal(voucherId);
          }
        } catch (error) {
          console.error('Error deleting detail:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const getSubjectName = (subjectId: number | null) => {
    const subject = accountSubjects.find((s) => s.id === subjectId);
    return subject ? `${subject.code} - ${subject.name}` : '-';
  };

  const filteredVouchers = vouchers.filter(
    (v) =>
      v.voucher_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (v.remark && v.remark.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const typeKeys: Record<string, string> = {
    general: 'vouchers.typeOptions.general',
    receipt: 'vouchers.typeOptions.receipt',
    payment: 'vouchers.typeOptions.payment',
    transfer: 'vouchers.typeOptions.transfer',
  };

  const statusKeys: Record<string, { textKey: string; color: string }> = {
    draft: { textKey: 'vouchers.statusOptions.draft', color: 'default' },
    posted: { textKey: 'vouchers.statusOptions.posted', color: 'success' },
    cancelled: { textKey: 'vouchers.statusOptions.cancelled', color: 'error' },
  };

  const columns = [
    {
      title: t('vouchers.voucherNo'),
      dataIndex: 'voucher_no',
      key: 'voucher_no',
    },
    {
      title: t('vouchers.date'),
      dataIndex: 'voucher_date',
      key: 'voucher_date',
    },
    {
      title: t('vouchers.type'),
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => (typeKeys[type] ? t(typeKeys[type]) : type),
    },
    {
      title: t('vouchers.amount'),
      dataIndex: 'total_amount',
      key: 'total_amount',
      render: (amount: number) => formatMoney(amount),
    },
    {
      title: t('vouchers.remark'),
      dataIndex: 'remark',
      key: 'remark',
      render: (text: string) => text || '-',
      ellipsis: true,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusKeys[status] || { textKey: status, color: 'default' };
        return <Tag color={config.color}>{t(config.textKey)}</Tag>;
      },
    },
    {
      title: t('common.actions'),
      key: 'action',
      width: 200,
      render: (_: any, record: Voucher) => (
        <Space size="small">
          {record.status === 'posted' ? (
            <Button type="text" onClick={() => handleReversePost(record)}>
              {t('vouchers.actions.reversePost')}
            </Button>
          ) : (
            <Button type="text" onClick={() => handlePost(record)}>
              {t('vouchers.actions.post')}
            </Button>
          )}
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} disabled={record.status === 'posted'}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)} disabled={record.status === 'posted'}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    {
      title: t('vouchers.lineNo'),
      dataIndex: 'line_no',
      key: 'line_no',
    },
    {
      title: t('vouchers.accountSubject'),
      dataIndex: 'subject_id',
      key: 'subject_id',
      render: (subjectId: number) => getSubjectName(subjectId),
    },
    {
      title: t('vouchers.summary'),
      dataIndex: 'summary',
      key: 'summary',
    },
    {
      title: t('vouchers.debitAmount'),
      dataIndex: 'debit_amount',
      key: 'debit_amount',
      render: (amount: number) => amount > 0 ? formatMoney(amount) : '-',
    },
    {
      title: t('vouchers.creditAmount'),
      dataIndex: 'credit_amount',
      key: 'credit_amount',
      render: (amount: number) => amount > 0 ? formatMoney(amount) : '-',
    },
    {
      title: t('vouchers.auxiliaryType'),
      dataIndex: 'auxiliary_type',
      key: 'auxiliary_type',
      render: (text: string) => text || '-',
    },
    {
      title: t('common.actions'),
      key: 'action',
      render: (_: any, record: VoucherDetail) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            {t('common.edit')}
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const detailTotal = details.reduce((acc, d) => ({
    debit: acc.debit + (d.debit_amount || 0),
    credit: acc.credit + (d.credit_amount || 0),
  }), { debit: 0, credit: 0 });

  return (
    <div>
      <SuperTable
        columns={columns}
        dataSource={filteredVouchers}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="vouchers"
        headerTitle={t('vouchers.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('vouchers.addVoucher')}</Button>
            <Input.Search
              allowClear
              placeholder={t('vouchers.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchVouchers}
              style={{ width: 240 }}
            />
          </Space>
        }
      />

      <SupaModal
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingVoucher(null);
          setSelectedVoucher(null);
        }}
        title={
          <>
            <AccountBookOutlined />
            <span>{editingVoucher ? t('vouchers.editVoucher') : t('vouchers.addVoucher')}</span>
          </>
        }
        headerPanelTitle={t('vouchers.headerPanelTitle')}
        detailPanelTitle={t('vouchers.detailPanelTitle')}
        historyTable={voucherTable}
        historyRecordId={editingVoucher?.id || selectedVoucher?.id}
        detailExtra={
          <Button type="link" size="small" icon={<PlusOutlined />} onClick={handleAddDetail}>{t('vouchers.addDetail')}</Button>
        }
        form={form}
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ padding: '0 16px 0 0' }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label={t('vouchers.voucherNo')}
                  name="voucher_no"
                  rules={[{ required: true, message: t('vouchers.voucherNoRequired') }]}
                >
                  <Input placeholder={t('vouchers.voucherNoPlaceholder')} disabled={!!editingVoucher} />
                </Form.Item>
                <Form.Item
                  label={t('vouchers.date')}
                  name="voucher_date"
                  rules={[{ required: true, message: t('vouchers.dateRequired') }]}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label={t('vouchers.type')} name="type" initialValue="general">
                  <Select>
                    <Option value="general">{t('vouchers.typeOptions.general')}</Option>
                    <Option value="receipt">{t('vouchers.typeOptions.receipt')}</Option>
                    <Option value="payment">{t('vouchers.typeOptions.payment')}</Option>
                    <Option value="transfer">{t('vouchers.typeOptions.transfer')}</Option>
                  </Select>
                </Form.Item>
                <Form.Item label={t('vouchers.totalAmount')} name="total_amount" initialValue={0}>
                  <InputNumber style={{ width: '100%' }} placeholder={t('vouchers.totalAmountPlaceholder')} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label={t('vouchers.remark')} name="remark">
                  <TextArea rows={5} placeholder={t('vouchers.remarkPlaceholder')} />
                </Form.Item>
                <Form.Item label={t('common.status')}>
                  <Tag color={editingVoucher?.status === 'posted' ? 'success' : editingVoucher?.status === 'cancelled' ? 'error' : 'default'}>
                    {editingVoucher ? t(statusKeys[editingVoucher.status || 'draft']?.textKey || editingVoucher.status || 'draft') : t('vouchers.statusOptions.draft')}
                  </Tag>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        detailData={details}
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={3} align="right"><strong>{t('vouchers.total')}</strong></Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="left"><strong>{formatMoney(detailTotal.debit)}</strong></Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="left"><strong>{formatMoney(detailTotal.credit)}</strong></Table.Summary.Cell>
                <Table.Summary.Cell index={3} colSpan={2}></Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={() => form.submit()}>{t('common.save')}</Button>
          </Space>
        }
        height={'80%'}
      />

      <SupaModal
        title={editingDetail ? t('vouchers.editVoucherDetail') : t('vouchers.addVoucherDetail')}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsDetailModalOpen(false)}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={() => detailForm.submit()}>
            {t('common.save')}
          </Button>
        </Space>}
        width={600}
        height={450}
        form={detailForm}
      >
        <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit} style={{ padding: '0 16px 0 0' }}>
          <Form.Item
            label={t('vouchers.accountSubject')}
            name="subject_id"
            rules={[{ required: true, message: t('vouchers.accountSubjectRequired') }]}
          >
            <Select placeholder={t('vouchers.accountSubjectPlaceholder')}>
              {accountSubjects.map((s) => (
                <Option key={s.id} value={s.id}>{s.code} - {s.name}</Option>
              ))}
            </Select>
          </Form.Item>
          
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label={t('vouchers.debitCreditDirection')}>
                <Switch checkedChildren={t('vouchers.debit')} unCheckedChildren={t('vouchers.credit')} checked={isDebit} onChange={setIsDebit} />
              </Form.Item>
            </Col>
            <Col span={12}>
              {isDebit ? (
                <Form.Item label={t('vouchers.debitAmount')} name="debit_amount" initialValue={0}>
                <MoneyInput min={0} step={0.01} style={{ width: '100%' }} placeholder={t('vouchers.debitAmountPlaceholder')} />
              </Form.Item>
              ) : (
                <Form.Item label={t('vouchers.creditAmount')} name="credit_amount" initialValue={0}>
                  <MoneyInput min={0} step={0.01} style={{ width: '100%' }} placeholder={t('vouchers.creditAmountPlaceholder')} />
                </Form.Item>
              )}
            </Col>
          </Row>
          <Form.Item label={t('vouchers.auxiliaryType')} name="auxiliary_type">
            <Input placeholder={t('vouchers.auxiliaryTypePlaceholder')} />
          </Form.Item>
          <Form.Item label={t('vouchers.summary')} name="summary">
            <TextArea rows={3} placeholder={t('vouchers.summaryPlaceholder')} />
          </Form.Item>
        </Form>
      </SupaModal>

    </div>
  );
}




