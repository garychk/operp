import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Tag, Modal, Form, Select, Space, message, InputNumber, DatePicker, Row, Col, Alert } from 'antd';
import dayjs from 'dayjs';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { generateIdempotencyKey } from '../../utils/uuid';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import { SupaModal, buildModalNav } from '../../components/SupaModal';
import { useCurrencyRegistry, fetchExchangeRate } from '../../utils/money';
import { MoneyInput } from '../../components/MoneyInput';
import { useTranslation } from 'react-i18next';

type Payable = Tables['erp_payables_s_539dcf81_b']['Row'];
type Supplier = Tables['erp_suppliers_s_539dcf81_b']['Row'];

const { Option } = Select;

const payableTable = 'erp_payables_s_539dcf81_b';

/** 币种代码规范化：空 / 本位币统一收敛成 null */
function normalizeCcy(value?: string | null): string | null {
  const text = String(value ?? '').trim().toUpperCase();
  return text || null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const todayText = () => new Date().toISOString().slice(0, 10);

export function Payables() {
  const { t } = useTranslation();
  const [payables, setPayables] = useState<Payable[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPayable, setEditingPayable] = useState<Payable | null>(null);
  const [form] = Form.useForm();
  const [openPeriodId, setOpenPeriodId] = useState<number>();
  const [settleForm] = Form.useForm();
  const [settleTarget, setSettleTarget] = useState<Payable | null>(null);
  const { formatMoney, baseCurrency, currencies, currencyLabel } = useCurrencyRegistry();

  const baseCcy = normalizeCcy(baseCurrency) ?? 'CNY';
  const currencyOptions = currencies.map((c) => ({
    value: c.code,
    label: `${c.code} · ${currencyLabel(c.code, c.name)}`,
  }));
  const formCurrency = Form.useWatch('currency', form);
  const formRate = Form.useWatch('exchange_rate', form);
  const isFormForeign = !!normalizeCcy(formCurrency) && normalizeCcy(formCurrency) !== baseCcy;

  const settleCcy = normalizeCcy(settleTarget?.currency);
  const settleIsForeign = !!settleCcy && settleCcy !== baseCcy;
  const settleRate = Form.useWatch('settlement_rate', settleForm);
  const settleAmount = Form.useWatch('amount', settleForm);

  /** 与 deploy_73 的 settle_ar_ap 同一套算法，所见即所得 */
  const settleBaseAmount = round2(Number(settleAmount || 0) * (settleIsForeign ? Number(settleRate || 0) : 1));
  const settleBalance = Number(settleTarget?.balance || 0);
  const settleBookAmount = settleBalance > 0.005
    ? round2(Number(settleTarget?.base_balance || 0) * Number(settleAmount || 0) / settleBalance)
    : settleBaseAmount;
  // 应付：实付 > 账面 = 多付了 = 损失（正）；符号约定与 6603 的净借方一致
  const settleFx = round2(settleBaseAmount - settleBookAmount);

  const fetchOpenPeriod = async () => {
    const { data } = await supabase.from('erp_accounting_periods_s_539dcf81_b').select('id').eq('is_deleted', 'n').eq('is_enabled', true).eq('is_closed', false).eq('is_locked', false).order('year', { ascending: false }).order('month', { ascending: false }).limit(1).maybeSingle();
    setOpenPeriodId(data?.id);
  };

  useEffect(() => {
    fetchPayables();
    fetchSuppliers();
    fetchOpenPeriod();
  }, []);

  const fetchPayables = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(payableTable)
        .select('*')
        .eq('is_deleted', 'n')
        .order('doc_date', { ascending: false });

      if (error) throw error;
      setPayables(data || []);
    } catch (error) {
      console.error('Error fetching payables:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchSuppliers = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_suppliers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setSuppliers(data || []);
    } catch (error) {
      console.error('Error fetching suppliers:', error);
    }
  };

  const handleFormCurrencyChange = async (code?: string) => {
    const next = normalizeCcy(code);
    if (!next || next === baseCcy) {
      form.setFieldValue('exchange_rate', 1);
      return;
    }
    const rate = await fetchExchangeRate(next, todayText());
    if (rate === null) {
      message.warning(t('currency.rateMissing', { code: next, date: todayText() }));
      return;
    }
    form.setFieldValue('exchange_rate', rate);
    message.success(t('currency.rateAutoFilled', { date: todayText() }));
  };

  const handleSubmit = async (values: any) => {
    try {
      const ccy = normalizeCcy(values.currency);
      const foreign = !!ccy && ccy !== baseCcy;
      const rate = foreign ? Number(values.exchange_rate || 0) : 1;
      if (foreign && !(rate > 0)) {
        message.error(t('currency.form.ratePositive'));
        return;
      }
      // base_amount / base_balance / base_paid_amount 由 deploy_78 的
      // trg_sync_ar_ap_base_amount 触发器统一落库，不在前端重复实现
      const payload = {
        ...values,
        currency: foreign ? ccy : null,
        exchange_rate: rate,
      };

      if (editingPayable) {
        await logWithTiming(t('payables.log.updateAction'), 'UPDATE', async () => {
          const { error } = await supabase
            .from(payableTable)
            .update(payload)
            .eq('id', editingPayable.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming(t('payables.log.createAction'), 'INSERT', async () => {
          const { error } = await supabase
            .from(payableTable)
            .insert([{
              ...payload,
              balance: values.amount,
            }]);
          if (error) throw error;
        });
        message.success(t('common.createSuccess'));
      }
      setIsModalOpen(false);
      form.resetFields();
      setEditingPayable(null);
      fetchPayables();
    } catch (error) {
      console.error('Error saving payable:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: Payable) => {
    setEditingPayable(record);
    const formValues: any = { ...record };
    if (formValues.doc_date) {
      formValues.doc_date = dayjs(formValues.doc_date);
    }
    if (formValues.due_date) {
      formValues.due_date = dayjs(formValues.due_date);
    }
    // 留空 = 本位币；'null' 收敛成 undefined，否则 Select 会显示成已选项
    formValues.currency = normalizeCcy(record.currency) ?? undefined;
    formValues.exchange_rate = record.exchange_rate ?? 1;
    form.setFieldsValue(formValues);
    setIsModalOpen(true);
  };

  const handleSettle = async (record: Payable) => {
    if (!openPeriodId) {
      message.warning(t('settlement.noPeriod'));
      return;
    }
    const ccy = normalizeCcy(record.currency);
    const foreign = !!ccy && ccy !== baseCcy;
    let rate: number | null = 1;
    if (foreign) {
      rate = await fetchExchangeRate(ccy as string, todayText());
      if (rate === null) {
        message.warning(t('currency.rateMissing', { code: ccy, date: todayText() }));
      }
    }
    setSettleTarget(record);
    settleForm.setFieldsValue({
      amount: Number(record.balance || 0),
      settlement_rate: rate ?? undefined,
    });
  };

  const confirmSettle = async () => {
    if (!settleTarget) return;
    const values = await settleForm.validateFields();
    const amount = Number(values.amount || 0);
    if (!openPeriodId || !(amount > 0)) throw new Error(t('settlement.invalid'));

    const rateValue = settleIsForeign ? Number(values.settlement_rate || 0) : null;
    if (settleIsForeign && !(rateValue && rateValue > 0)) throw new Error(t('currency.form.ratePositive'));

    const { error } = await supabase.rpc('settle_ar_ap', {
      p_settlement_type: 'payable',
      p_source_id: settleTarget.id,
      p_period_id: openPeriodId,
      p_amount: amount,
      p_settlement_date: todayText(),
      p_remark: null,
      p_idempotency_key: generateIdempotencyKey(),
      // deploy_73 新增第 8 参数（核销汇率），本位币单据传 null
      p_settlement_rate: rateValue,
    });
    if (error) throw error;
    message.success(t('settlement.successPayable'));
    setSettleTarget(null);
    settleForm.resetFields();
    fetchPayables();
  };


  const handleSelectedSettle = () => {
    if (selectedRowKeys.length !== 1) {
      message.warning(t('settlement.selectOnePayable'));
      return;
    }
    const record = payables.find((item) => item.id === Number(selectedRowKeys[0]));
    if (record) handleSettle(record);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('payables.confirm.deleteContent'),
      onOk: async () => {
        try {
          await logWithTiming(t('payables.log.deleteAction'), 'DELETE', async () => {
            const { error } = await supabase
              .from(payableTable)
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success(t('common.deleteSuccess'));
          fetchPayables();
        } catch (error) {
          console.error('Error deleting payable:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingPayable(null);
    form.setFieldsValue({
      supplier_id: undefined,
      doc_type: 'invoice',
      doc_no: '',
      doc_date: dayjs(),
      due_date: '',
      amount: 0,
      currency: undefined,
      exchange_rate: 1,
      remark: '',
    });
    setIsModalOpen(true);
  };

  const getSupplierName = (supplierId: number | null) => {
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || '-';
  };

  const filteredPayables = payables.filter(
    (p) =>
      p.doc_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getSupplierName(p.supplier_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { textKey: string; color: string }> = {
    open: { textKey: 'payables.statusOptions.open', color: 'warning' },
    partially_paid: { textKey: 'payables.statusOptions.partially_paid', color: 'processing' },
    closed: { textKey: 'payables.statusOptions.closed', color: 'success' },
    overdue: { textKey: 'payables.statusOptions.overdue', color: 'error' },
  };

  const columns = [
    {
      title: t('payables.docNo'),
      dataIndex: 'doc_no',
      key: 'doc_no',
    },
    {
      title: t('payables.supplier'),
      dataIndex: 'supplier_id',
      key: 'supplier_id',
      render: (supplierId: number) => getSupplierName(supplierId),
    },
    {
      title: t('currency.field.currency'),
      dataIndex: 'currency',
      key: 'currency',
      width: 100,
      render: (code: string | null) => {
        const ccy = normalizeCcy(code);
        if (!ccy) return <Tag>{t('currency.baseTag')}</Tag>;
        return <Tag color="blue">{ccy}</Tag>;
      },
    },
    {
      title: t('payables.docDate'),
      dataIndex: 'doc_date',
      key: 'doc_date',
    },
    {
      title: t('payables.dueDate'),
      dataIndex: 'due_date',
      key: 'due_date',
      render: (text: string) => text || '-',
    },
    {
      title: t('currency.field.foreignAmount'),
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number, record: Payable) => formatMoney(amount, record.currency),
    },
    {
      title: t('currency.field.fcBalance'),
      dataIndex: 'balance',
      key: 'balance',
      render: (balance: number, record: Payable) => formatMoney(balance, record.currency),
    },
    {
      // 账面本位币余额：被期末调汇改写后与「原币余额 × 单据汇率」不再相等，
      // 差额就是已累计确认的调汇额（与 vw_erp_ar_ap_open.revalued_fx 同口径）
      title: t('currency.bookBaseBalance'),
      dataIndex: 'base_balance',
      key: 'base_balance',
      render: (value: number, record: Payable) => {
        const book = value === null || value === undefined ? null : Number(value);
        const atDocRate = round2(Number(record.balance || 0) * Number(record.exchange_rate || 1));
        const revalued = book === null ? 0 : round2(book - atDocRate);
        return (
          <Space size={4}>
            <span>{formatMoney(book, baseCurrency)}</span>
            {Math.abs(revalued) >= 0.005 && (
              <Tag color="orange" title={t('currency.revaluedHint')}>
                {t('currency.revaluedTag', { amount: formatMoney(revalued, baseCurrency) })}
              </Tag>
            )}
          </Space>
        );
      },
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
      render: (_: any, record: Payable) => (
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
        dataSource={filteredPayables}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="payables"
        headerTitle={t('payables.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('payables.addPayable')}</Button>
            <Button onClick={handleSelectedSettle} disabled={!openPeriodId || selectedRowKeys.length !== 1}>{t('settlement.button')}</Button>
            <Input.Search
              allowClear
              placeholder={t('payables.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchPayables}
              style={{ width: 240 }}
            />
          </Space>
        }
      />
      <SupaModal
        title={editingPayable ? t('payables.editPayable') : t('payables.addPayable')}
        open={isModalOpen}
        width={800}
        height={560}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingPayable(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={() => form.submit()}>
            {t('common.save')}
          </Button>
        </Space>}
        historyTable={payableTable}
        navigation={buildModalNav(filteredPayables, editingPayable?.id, handleEdit)}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ padding: '0 16px 0 0' }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('payables.supplier')}
                name="supplier_id"
                rules={[{ required: true, message: t('payables.supplierRequired') }]}
              >
                <Select placeholder={t('payables.supplierPlaceholder')}>
                  {suppliers.map((s) => (
                    <Option key={s.id} value={s.id}>{s.name}</Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label={t('payables.docType')} name="doc_type" initialValue="invoice">
                <Select>
                  <Option value="invoice">{t('payables.typeOptions.invoice')}</Option>
                  <Option value="order">{t('payables.typeOptions.order')}</Option>
                  <Option value="other">{t('payables.typeOptions.other')}</Option>
                </Select>
              </Form.Item>
              <Form.Item
                label={t('payables.docNo')}
                name="doc_no"
                rules={[{ required: true, message: t('payables.docNoRequired') }]}
              >
                <Input placeholder={t('payables.docNoPlaceholder')} disabled={!!editingPayable} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('payables.docDate')}
                name="doc_date"
                rules={[{ required: true, message: t('payables.docDateRequired') }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item label={t('payables.dueDate')} name="due_date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label={t('payables.amount')}
                name="amount"
                rules={[{ required: true, message: t('payables.amountRequired') }]}
                initialValue={0}
              >
                <MoneyInput
                  currency={isFormForeign ? formCurrency : baseCurrency}
                  min={0}
                  step={0.01}
                  style={{ width: '100%' }}
                  placeholder={t('payables.amountPlaceholder')}
                />
              </Form.Item>
              <Form.Item
                label={t('currency.field.currency')}
                name="currency"
                extra={t('currency.baseHint')}
              >
                <Select
                  allowClear
                  placeholder={t('currency.baseOption', { code: baseCurrency })}
                  options={currencyOptions}
                  onChange={handleFormCurrencyChange}
                />
              </Form.Item>
              <Form.Item
                label={t('currency.field.exchangeRate')}
                name="exchange_rate"
                initialValue={1}
                extra={isFormForeign ? t('currency.rateHint', { foreign: normalizeCcy(formCurrency), rate: formRate, base: baseCurrency }) : undefined}
              >
                <InputNumber
                  min={0}
                  step={0.000001}
                  precision={8}
                  style={{ width: '100%' }}
                  disabled={!isFormForeign}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('payables.remark')} name="remark">
            <Input.TextArea rows={3} placeholder={t('payables.remarkPlaceholder')} />
          </Form.Item>
        </Form>
      </SupaModal>

      {/* 核销弹窗：外币单据多一个「核销汇率」，差额即汇兑损益（进 6603） */}
      <Modal
        title={t('settlement.titlePayable')}
        open={!!settleTarget}
        width={520}
        okButtonProps={{ disabled: !openPeriodId }}
        onCancel={() => {
          setSettleTarget(null);
          settleForm.resetFields();
        }}
        onOk={() => confirmSettle().catch((error: any) => {
          message.error(error?.message || t('settlement.failedPayable'));
        })}
      >
        <Form form={settleForm} layout="vertical">
          <Form.Item label={t('settlement.source')}>
            <Input readOnly value={settleTarget ? `${settleTarget.doc_no} · ${getSupplierName(settleTarget.supplier_id)}` : ''} />
          </Form.Item>
          <Form.Item label={t('settlement.openOriginal')}>
            <Input readOnly value={formatMoney(settleTarget?.balance, settleTarget?.currency)} />
          </Form.Item>
          <Form.Item
            label={t('settlement.amount')}
            name="amount"
            rules={[{ required: true, message: t('settlement.amountRequired') }]}
          >
            <MoneyInput
              currency={settleIsForeign ? settleCcy : baseCurrency}
              min={0.01}
              max={Number(settleTarget?.balance || 0)}
              step={0.01}
              style={{ width: '100%' }}
            />
          </Form.Item>
          {settleIsForeign && (
            <>
              <Form.Item
                label={t('settlement.rate')}
                name="settlement_rate"
                extra={t('settlement.rateHint')}
                rules={[{ required: true, message: t('currency.form.rateRequired') }]}
              >
                <InputNumber min={0} step={0.000001} precision={8} style={{ width: '100%' }} />
              </Form.Item>
              <Alert
                type={Math.abs(settleFx) < 0.005 ? 'success' : settleFx > 0 ? 'warning' : 'info'}
                showIcon
                message={t('settlement.previewMessage', {
                  base: formatMoney(settleBaseAmount, baseCurrency),
                })}
                description={
                  Math.abs(settleFx) < 0.005
                    ? t('settlement.noFx')
                    : t('settlement.fxPreview', {
                        amount: formatMoney(Math.abs(settleFx), baseCurrency),
                        type: settleFx > 0 ? t('currency.fxLoss') : t('currency.fxGain'),
                      })
                }
              />
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
