import { useEffect, useState } from 'react';
import { Button, Input, Table, Tag, Modal, Form, Select, Space, Card, message, InputNumber, DatePicker, Row, Col } from 'antd';
import { PlusOutlined, SearchOutlined, EyeOutlined, DeleteOutlined, EditOutlined, AccountBookOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import type { Tables } from '../../utils/supabase';
import { SupaModal } from '../../components/SupaModal';
import dayjs from 'dayjs';

type Voucher = Tables['erp_vouchers_s_539dcf81_b']['Row'];
type VoucherDetail = Tables['erp_voucher_details_s_539dcf81_b']['Row'];
type AccountSubject = Tables['erp_account_subjects_s_539dcf81_b']['Row'];

const { Option } = Select;
const { TextArea } = Input;

export function Vouchers() {
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [accountSubjects, setAccountSubjects] = useState<AccountSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null);
  const [selectedVoucher, setSelectedVoucher] = useState<Voucher | null>(null);
  const [details, setDetails] = useState<VoucherDetail[]>([]);
  const [editingDetail, setEditingDetail] = useState<VoucherDetail | null>(null);
  const [detailForm] = Form.useForm();
  const [form] = Form.useForm();

  useEffect(() => {
    fetchVouchers();
    fetchAccountSubjects();
  }, []);

  const fetchVouchers = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('erp_vouchers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .order('voucher_date', { ascending: false });

      if (error) throw error;
      setVouchers(data || []);
    } catch (error) {
      console.error('Error fetching vouchers:', error);
      message.error('获取数据失败');
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
        .from('erp_voucher_details_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('voucher_id', voucherId)
        .order('line_no');
      if (error) throw error;
      setDetails(data || []);
    } catch (error) {
      console.error('Error fetching details:', error);
      message.error('获取明细失败');
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingVoucher) {
        const { error } = await supabase
          .from('erp_vouchers_s_539dcf81_b')
          .update(values)
          .eq('id', editingVoucher.id);
        if (error) throw error;
        message.success('更新成功');
      } else {
        const { data, error } = await supabase
          .from('erp_vouchers_s_539dcf81_b')
          .insert([values])
          .select();
        if (error) throw error;
        message.success('新增成功');
        if (data && data.length > 0) {
          setSelectedVoucher(data[0]);
        }
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingVoucher(null);
      fetchVouchers();
    } catch (error) {
      console.error('Error saving voucher:', error);
      message.error('保存失败');
    }
  };

  const handleDetailSubmit = async (values: any) => {
    try {
      if (!selectedVoucher && !editingVoucher) {
        message.error('请先选择凭证');
        return;
      }

      const voucherId = selectedVoucher?.id || editingVoucher?.id;
      if (!voucherId) {
        message.error('请先保存凭证');
        return;
      }

      if (editingDetail) {
        await supabase
          .from('erp_voucher_details_s_539dcf81_b')
          .update(values)
          .eq('id', editingDetail.id);
        message.success('更新成功');
      } else {
        const maxLineNo = details.length > 0 ? Math.max(...details.map(d => d.line_no)) : 0;
        values.line_no = maxLineNo + 1;
        values.voucher_id = voucherId;
        values.debit_amount = values.debit_amount || 0;
        values.credit_amount = values.credit_amount || 0;
        values.is_deleted = 'n';

        const { error } = await supabase
          .from('erp_voucher_details_s_539dcf81_b')
          .insert([values]);
        if (error) throw error;
        message.success('新增成功');
      }
      setIsDetailModalOpen(false);
      detailForm.resetFields();
      setEditingDetail(null);
      fetchDetails(voucherId);
      updateVoucherTotal(voucherId);
    } catch (error) {
      console.error('Error saving detail:', error);
      message.error('保存失败');
    }
  };

  const updateVoucherTotal = async (voucherId: number) => {
    try {
      const { data, error } = await supabase
        .from('erp_voucher_details_s_539dcf81_b')
        .select('debit_amount, credit_amount')
        .eq('is_deleted', 'n')
        .eq('voucher_id', voucherId);
      if (error) throw error;

      const totalDebit = data?.reduce((sum, d) => sum + (d.debit_amount || 0), 0) || 0;
      const totalCredit = data?.reduce((sum, d) => sum + (d.credit_amount || 0), 0) || 0;
      const totalAmount = Math.max(totalDebit, totalCredit);

      await supabase
        .from('erp_vouchers_s_539dcf81_b')
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

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该凭证吗？',
      onOk: async () => {
        try {
          const { error } = await supabase
            .from('erp_vouchers_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          if (error) throw error;
          await supabase
            .from('erp_voucher_details_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('voucher_id', id);
          message.success('删除成功');
          fetchVouchers();
        } catch (error) {
          console.error('Error deleting voucher:', error);
          message.error('删除失败');
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingVoucher(null);
    setDetails([]);
    form.setFieldsValue({
      voucher_no: `V${Date.now().toString().slice(-8)}`,
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
    detailForm.setFieldsValue(record);
    setIsDetailModalOpen(true);
  };

  const handleDeleteDetail = async (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除该明细吗？',
      onOk: async () => {
        try {
          await supabase
            .from('erp_voucher_details_s_539dcf81_b')
            .update({ is_deleted: 'y' })
            .eq('id', id);
          message.success('删除成功');
          const voucherId = selectedVoucher?.id || editingVoucher?.id;
          if (voucherId) {
            fetchDetails(voucherId);
            updateVoucherTotal(voucherId);
          }
        } catch (error) {
          console.error('Error deleting detail:', error);
          message.error('删除失败');
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

  const typeLabels: Record<string, string> = {
    general: '记账凭证',
    receipt: '收款凭证',
    payment: '付款凭证',
    transfer: '转账凭证',
  };

  const statusLabels: Record<string, { text: string; color: string }> = {
    draft: { text: '草稿', color: 'default' },
    posted: { text: '已过账', color: 'success' },
    cancelled: { text: '已作废', color: 'error' },
  };

  const columns = [
    {
      title: '凭证号',
      dataIndex: 'voucher_no',
      key: 'voucher_no',
    },
    {
      title: '日期',
      dataIndex: 'voucher_date',
      key: 'voucher_date',
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      render: (type: string) => typeLabels[type] || type,
    },
    {
      title: '金额',
      dataIndex: 'total_amount',
      key: 'total_amount',
      render: (amount: number) => `¥${(amount ?? 0).toLocaleString()}`,
    },
    {
      title: '摘要',
      dataIndex: 'remark',
      key: 'remark',
      render: (text: string) => text || '-',
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const config = statusLabels[status] || { text: status, color: 'default' };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: Voucher) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const detailColumns = [
    {
      title: '行号',
      dataIndex: 'line_no',
      key: 'line_no',
    },
    {
      title: '会计科目',
      dataIndex: 'subject_id',
      key: 'subject_id',
      render: (subjectId: number) => getSubjectName(subjectId),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      key: 'summary',
    },
    {
      title: '借方金额',
      dataIndex: 'debit_amount',
      key: 'debit_amount',
      render: (amount: number) => amount > 0 ? `¥${amount.toFixed(2)}` : '-',
    },
    {
      title: '贷方金额',
      dataIndex: 'credit_amount',
      key: 'credit_amount',
      render: (amount: number) => amount > 0 ? `¥${amount.toFixed(2)}` : '-',
    },
    {
      title: '辅助核算类型',
      dataIndex: 'auxiliary_type',
      key: 'auxiliary_type',
      render: (text: string) => text || '-',
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: VoucherDetail) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditDetail(record)}>
            编辑
          </Button>
          <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteDetail(record.id)}>
            删除
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
    <Card variant="borderless" title="凭证管理" extra={
      <Space>
        <Input
          placeholder="搜索凭证号或摘要..."
          prefix={<SearchOutlined />}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增凭证</Button>
      </Space>
    }>
      <Table
        columns={columns}
        dataSource={filteredVouchers}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <SupaModal
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingVoucher(null);
        }}
        title={
          <>
            <AccountBookOutlined />
            <span>{editingVoucher ? '编辑凭证' : '新增凭证'}</span>
          </>
        }
        headerPanelTitle="会计凭证"
        detailPanelTitle="分录明细"
        detailExtra={
          <Button type="link" size="small" icon={<PlusOutlined />} onClick={handleAddDetail}>新增明细</Button>
        }
        form={form}
        formEle={
          <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ padding: '0 16px 0 0' }}>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="凭证号"
                  name="voucher_no"
                  rules={[{ required: true, message: '请输入凭证号' }]}
                >
                  <Input placeholder="请输入凭证号" disabled={!!editingVoucher} />
                </Form.Item>
                <Form.Item
                  label="日期"
                  name="voucher_date"
                  rules={[{ required: true, message: '请选择日期' }]}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="类型" name="type" initialValue="general">
                  <Select>
                    <Option value="general">记账凭证</Option>
                    <Option value="receipt">收款凭证</Option>
                    <Option value="payment">付款凭证</Option>
                    <Option value="transfer">转账凭证</Option>
                  </Select>
                </Form.Item>
                <Form.Item label="总金额" name="total_amount" initialValue={0}>
                  <InputNumber style={{ width: '100%' }} placeholder="请输入总金额" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="备注" name="remark">
                  <TextArea rows={5} placeholder="请输入备注" />
                </Form.Item>
                <Form.Item label="状态" name="status" initialValue="draft">
                  <Select>
                    <Option value="draft">草稿</Option>
                    <Option value="posted">已过账</Option>
                    <Option value="cancelled">已作废</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>
          </Form>
        }
        tableEle={
          <Table
            columns={detailColumns}
            dataSource={details}
            rowKey="id"
            pagination={false}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={3} align="right"><strong>合计</strong></Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="left"><strong>¥{detailTotal.debit.toFixed(2)}</strong></Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="left"><strong>¥{detailTotal.credit.toFixed(2)}</strong></Table.Summary.Cell>
                <Table.Summary.Cell index={3} colSpan={2}></Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        }
        footer={
          <Space>
            <Button onClick={() => setIsModalOpen(false)}>取消</Button>
            <Button type="primary" onClick={() => form.submit()}>保存</Button>
          </Space>
        }
        height={680}
      />

      <SupaModal
        title={editingDetail ? '编辑凭证明细' : '新增凭证明细'}
        open={isDetailModalOpen}
        onCancel={() => {
          setIsDetailModalOpen(false);
          detailForm.resetFields();
          setEditingDetail(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsDetailModalOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => detailForm.submit()}>
            保存
          </Button>
        </Space>}
        width={1000}
        height={500}
        form={detailForm}
        formEle={
          <Form form={detailForm} layout="vertical" onFinish={handleDetailSubmit} style={{ marginRight: 16 }}>
            <Form.Item
              label="会计科目"
              name="subject_id"
              rules={[{ required: true, message: '请选择会计科目' }]}
            >
              <Select placeholder="请选择会计科目">
                {accountSubjects.map((s) => (
                  <Option key={s.id} value={s.id}>{s.code} - {s.name}</Option>
                ))}
              </Select>
            </Form.Item>
            <Form.Item label="摘要" name="summary">
              <TextArea rows={3} placeholder="请输入摘要" />
            </Form.Item>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="借方金额" name="debit_amount" initialValue={0}>
                  <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="请输入借方金额" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="贷方金额" name="credit_amount" initialValue={0}>
                  <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="请输入贷方金额" />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item label="辅助核算类型" name="auxiliary_type">
              <Input placeholder="请输入辅助核算类型" />
            </Form.Item>
          </Form>}
      />
    </Card>
  );
}
