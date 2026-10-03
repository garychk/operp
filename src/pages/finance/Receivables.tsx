import { useEffect, useState } from 'react';
import type { Key } from 'react';
import { Button, Input, Tag, Modal, Form, Select, Space, message, InputNumber, DatePicker, Row, Col, Alert } from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { logWithTiming } from '../../utils/logger';
import { generateIdempotencyKey } from '../../utils/uuid';
import type { Tables } from '../../utils/supabase';
import { SuperTable } from '../../components/SuperTable';
import dayjs from 'dayjs';
import { SupaModal } from '../../components/SupaModal';
import { useCurrencyRegistry, fetchExchangeRate } from '../../utils/money';
import { MoneyInput } from '../../components/MoneyInput';
import { useTranslation } from 'react-i18next';

type Receivable = Tables['erp_receivables_s_539dcf81_b']['Row'];
type Customer = Tables['erp_customers_s_539dcf81_b']['Row'];

const { Option } = Select;
const tableName = 'erp_receivables_s_539dcf81_b';

/** 币种代码规范化：空 / 本位币统一收敛成 null */
function normalizeCcy(value?: string | null): string | null {
  const text = String(value ?? '').trim().toUpperCase();
  return text || null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const todayText = () => new Date().toISOString().slice(0, 10);

export function Receivables() {
  const { t } = useTranslation();
  const [receivables, setReceivables] = useState<Receivable[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingReceivable, setEditingReceivable] = useState<Receivable | null>(null);
  const [form] = Form.useForm();
  const [openPeriodId, setOpenPeriodId] = useState<number>();
  const [settleForm] = Form.useForm();
  /** 非空即打开核销弹窗；用 record 自身驱动，避免"选中行"与"要核销的行"两份状态 */
  const [settleTarget, setSettleTarget] = useState<Receivable | null>(null);
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

  /**
   * 核销本位币 = 原币 × 核销汇率；账面冲减 = 按**当前账面余额比率**冲减。
   * 与 deploy_73 的 settle_ar_ap 同一套算法，所以这里的预览值就是入库后的值
   * （调汇过的单据账面上已按期末汇率重估，不能再按单据汇率冲）。
   */
  const settleBaseAmount = round2(Number(settleAmount || 0) * (settleIsForeign ? Number(settleRate || 0) : 1));
  const settleBalance = Number(settleTarget?.balance || 0);
  const settleBookAmount = settleBalance > 0.005
    ? round2(Number(settleTarget?.base_balance || 0) * Number(settleAmount || 0) / settleBalance)
    : settleBaseAmount;
  // 应收：实收 < 账面 = 少收了 = 损失（正）；符号约定与 6603 的净借方一致
  const settleFx = round2(settleBookAmount - settleBaseAmount);

  const fetchOpenPeriod = async () => {
    const { data } = await supabase.from('erp_accounting_periods_s_539dcf81_b').select('id').eq('is_deleted', 'n').eq('is_enabled', true).eq('is_closed', false).eq('is_locked', false).order('year', { ascending: false }).order('month', { ascending: false }).limit(1).maybeSingle();
    setOpenPeriodId(data?.id);
  };

  useEffect(() => {
    fetchReceivables();
    fetchCustomers();
    fetchOpenPeriod();
  }, []);

  const fetchReceivables = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from(tableName)
        .select('*')
        .eq('is_deleted', 'n')
        .order('doc_date', { ascending: false });

      if (error) throw error;
      setReceivables(data || []);
    } catch (error) {
      console.error('Error fetching receivables:', error);
      message.error(t('common.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchCustomers = async () => {
    try {
      const { data, error } = await supabase
        .from('erp_customers_s_539dcf81_b')
        .select('*')
        .eq('is_deleted', 'n')
        .eq('status', 'active');
      if (error) throw error;
      setCustomers(data || []);
    } catch (error) {
      console.error('Error fetching customers:', error);
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
      // base_amount / base_balance / base_paid_amount 一律交给 deploy_78 的
      // trg_sync_ar_ap_base_amount 触发器按 amount × exchange_rate 落库 ——
      // 这里**不要**再算一遍，否则又是两套口径（核销会按错的账面值算汇兑损益）
      const payload = {
        ...values,
        currency: foreign ? ccy : null,
        exchange_rate: rate,
      };

      if (editingReceivable) {
        await logWithTiming(t('receivables.log.updateAction'), 'UPDATE', async () => {
          const { error } = await supabase
            .from(tableName)
            .update(payload)
            .eq('id', editingReceivable.id);
          if (error) throw error;
        });
        message.success(t('common.updateSuccess'));
      } else {
        await logWithTiming(t('receivables.log.createAction'), 'INSERT', async () => {
          const { error } = await supabase
            .from(tableName)
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
      setEditingReceivable(null);
      fetchReceivables();
    } catch (error) {
      console.error('Error saving receivable:', error);
      message.error(t('common.saveFailed'));
    }
  };

  const handleEdit = (record: Receivable) => {
    setEditingReceivable(record);
    form.setFieldsValue({
      ...record,
      doc_date: dayjs(record.doc_date),
      due_date: dayjs(record.due_date),
      // 留空 = 本位币；'null' 收敛成 undefined，否则 Select 会显示成已选项
      currency: normalizeCcy(record.currency) ?? undefined,
      exchange_rate: record.exchange_rate ?? 1,
    });
    setIsModalOpen(true);
  };

  const handleSettle = async (record: Receivable) => {
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

    // deploy_73 给 settle_ar_ap 加了第 8 个参数 p_settlement_rate。
    // Postgres 不允许 CREATE OR REPLACE 改参数列表（旧 7 参版本已 DROP），
    // 所以这里是**必传项**，本位币单据传 null 即可。
    const { error } = await supabase.rpc('settle_ar_ap', {
      p_settlement_type: 'receivable',
      p_source_id: settleTarget.id,
      p_period_id: openPeriodId,
      p_amount: amount,
      p_settlement_date: todayText(),
      p_remark: null,
      p_idempotency_key: generateIdempotencyKey(),
      p_settlement_rate: rateValue,
    });
    if (error) throw error;
    message.success(t('settlement.successReceivable'));
    setSettleTarget(null);
    settleForm.resetFields();
    fetchReceivables();
  };


  const handleSelectedSettle = () => {
    if (selectedRowKeys.length !== 1) {
      message.warning(t('settlement.selectOneReceivable'));
      return;
    }
    const record = receivables.find((item) => item.id === Number(selectedRowKeys[0]));
    if (record) handleSettle(record);
  };

  const handleDelete = async (id: number) => {
    Modal.confirm({
      title: t('common.confirmDelete'),
      content: t('receivables.confirm.deleteContent'),
      onOk: async () => {
        try {
          await logWithTiming(t('receivables.log.deleteAction'), 'DELETE', async () => {
            const { error } = await supabase
              .from(tableName)
              .update({ is_deleted: 'y' })
              .eq('id', id);
            if (error) throw error;
          });
          message.success(t('common.deleteSuccess'));
          fetchReceivables();
        } catch (error) {
          console.error('Error deleting receivable:', error);
          message.error(t('common.deleteFailed'));
        }
      },
    });
  };

  const handleAdd = () => {
    setEditingReceivable(null);
    form.setFieldsValue({
      customer_id: undefined,
      doc_type: 'invoice',
      doc_no: '',
      doc_date: dayjs(new Date()),
      due_date: '',
      amount: 0,
      currency: undefined,
      exchange_rate: 1,
      remark: '',
    });
    setIsModalOpen(true);
  };

  const getCustomerName = (customerId: number | null) => {
    const customer = customers.find((c) => c.id === customerId);
    return customer?.name || '-';
  };

  const filteredReceivables = receivables.filter(
    (r) =>
      r.doc_no.toLowerCase().includes(searchTerm.toLowerCase()) ||
      getCustomerName(r.customer_id).toLowerCase().includes(searchTerm.toLowerCase())
  );

  const statusLabels: Record<string, { textKey: string; color: string }> = {
    open: { textKey: 'receivables.statusOptions.open', color: 'warning' },
    partially_paid: { textKey: 'receivables.statusOptions.partially_paid', color: 'processing' },
    closed: { textKey: 'receivables.statusOptions.closed', color: 'success' },
    overdue: { textKey: 'receivables.statusOptions.overdue', color: 'error' },
  };

  const columns = [
    {
      title: t('receivables.docNo'),
      dataIndex: 'doc_no',
      key: 'doc_no',
    },
    {
      title: t('receivables.customer'),
      dataIndex: 'customer_id',
      key: 'customer_id',
      render: (customerId: number) => getCustomerName(customerId),
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
      title: t('receivables.docDate'),
      dataIndex: 'doc_date',
      key: 'doc_date',
    },
    {
      title: t('receivables.dueDate'),
      dataIndex: 'due_date',
      key: 'due_date',
      render: (text: string) => text || '-',
    },
    {
      // 原币金额：带该单据的币种，与「币种」列并排看
      title: t('currency.field.foreignAmount'),
      dataIndex: 'amount',
      key: 'amount',
      render: (amount: number, record: Receivable) => formatMoney(amount, record.currency),
    },
    {
      title: t('currency.field.fcBalance'),
      dataIndex: 'balance',
      key: 'balance',
      render: (balance: number, record: Receivable) => formatMoney(balance, record.currency),
    },
    {
      // 账面本位币余额：会被期末调汇改写，故与「原币余额 × 单据汇率」可能不等
      title: t('currency.bookBaseBalance'),
      dataIndex: 'base_balance',
      key: 'base_balance',
      render: (value: number, record: Receivable) => {
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
      render: (_: any, record: Receivable) => (
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
        dataSource={filteredReceivables}
        rowKey="id"
        loading={loading}
        pagination={{ pageSize: 10 }}
        storageKey="receivables"
        headerTitle={t('receivables.title')}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
        }}
        queryBar={
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>{t('receivables.addReceivable')}</Button>
            <Button onClick={handleSelectedSettle} disabled={!openPeriodId || selectedRowKeys.length !== 1}>{t('settlement.button')}</Button>
            <Input.Search
              allowClear
              placeholder={t('receivables.searchPlaceholder')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onSearch={fetchReceivables}
              style={{ width: 240 }}
            />
          </Space>
        }
      />
      <SupaModal
        title={editingReceivable ? t('receivables.editReceivable') : t('receivables.addReceivable')}
        open={isModalOpen}
        width={800}
        height={560}
        onCancel={() => {
          setIsModalOpen(false);
          form.resetFields();
          setEditingReceivable(null);
        }}
        footer={<Space>
          <Button onClick={() => setIsModalOpen(false)}>{t('common.cancel')}</Button>
          <Button type="primary" onClick={() => form.submit()}>
            {t('common.save')}
          </Button>
        </Space>}
        historyTable={tableName}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit} style={{ padding: '0 16px 0 0' }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                label={t('receivables.customer')}
                name="customer_id"
                rules={[{ required: true, message: t('receivables.customerRequired') }]}
              >
                <Select placeholder={t('receivables.customerPlaceholder')}>
                  {customers.map((c) => (
                    <Option key={c.id} value={c.id}>{c.name}</Option>
                  ))}
                </Select>
              </Form.Item>
              <Form.Item label={t('receivables.docType')} name="doc_type" initialValue="invoice">
                <Select>
                  <Option value="invoice">{t('receivables.typeOptions.invoice')}</Option>
                  <Option value="order">{t('receivables.typeOptions.order')}</Option>
                  <Option value="other">{t('receivables.typeOptions.other')}</Option>
                </Select>
              </Form.Item>
              <Form.Item
                label={t('receivables.docNo')}
                name="doc_no"
                rules={[{ required: true, message: t('receivables.docNoRequired') }]}
              >
                <Input placeholder={t('receivables.docNoPlaceholder')} disabled={!!editingReceivable} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('receivables.docDate')}
                name="doc_date"
                rules={[{ required: true, message: t('receivables.docDateRequired') }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item label={t('receivables.dueDate')} name="due_date">
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label={t('receivables.amount')}
                name="amount"
                rules={[{ required: true, message: t('receivables.amountRequired') }]}
                initialValue={0}
              >
                <MoneyInput
                  currency={isFormForeign ? formCurrency : baseCurrency}
                  min={0}
                  step={0.01}
                  style={{ width: '100%' }}
                  placeholder={t('receivables.amountPlaceholder')}
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
          <Form.Item label={t('receivables.remark')} name="remark">
            <Input.TextArea rows={3} placeholder={t('receivables.remarkPlaceholder')} />
          </Form.Item>
        </Form>
      </SupaModal>

      {/* 核销弹窗：外币单据多一个「核销汇率」，差额即汇兑损益（进 6603）。
          没有用 Modal.confirm，因为要在提交前把「折合本位币 / 预计汇兑损益」算给用户看 —— 
          汇兑损益是**看不见就会做错**的东西，必须当场可见。 */}
      <Modal
        title={t('settlement.titleReceivable')}
        open={!!settleTarget}
        width={520}
        okButtonProps={{ disabled: !openPeriodId }}
        onCancel={() => {
          setSettleTarget(null);
          settleForm.resetFields();
        }}
        onOk={() => confirmSettle().catch((error: any) => {
          message.error(error?.message || t('settlement.failedReceivable'));
        })}
      >
        <Form form={settleForm} layout="vertical">
          <Form.Item label={t('settlement.source')}>
            <Input readOnly value={settleTarget ? `${settleTarget.doc_no} · ${getCustomerName(settleTarget.customer_id)}` : ''} />
          </Form.Item>
          <Form.Item label={t('settlement.openOriginal')}>
            <Input
              readOnly
              value={formatMoney(settleTarget?.balance, settleTarget?.currency)}
            />
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
