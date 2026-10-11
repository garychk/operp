import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  message,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  PlusOutlined,
  SearchOutlined,
  StarOutlined,
} from "@ant-design/icons";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";
import { supabase } from "../../utils/supabase";
import type { Tables } from "../../utils/supabase";
import { logWithTiming } from "../../utils/logger";
import { useAuth } from "../../contexts/AuthContext";
import SimpleModal from "../../components/SimpleModal";
import { SuperTable } from "../../components/SuperTable";
import { EXCHANGE_RATE_TABLE, formatRate, refreshCurrencyRegistry } from "../../utils/money";
import { fetchCfetsQuote } from "../../utils/fxSource";

const { Option } = Select;

const CURRENCY_TABLE = "erp_currencies_s_539dcf81_b";
const RATE_TYPES = ["spot", "monthly", "custom"] as const;

type Currency = Tables["erp_currencies_s_539dcf81_b"]["Row"];
type ExchangeRate = Tables["erp_exchange_rates_s_539dcf81_b"]["Row"];

interface CurrencyFormValues {
  code: string;
  name: string;
  symbol?: string | null;
  decimal_places: number;
  status?: string;
  sort_order?: number;
  remark?: string | null;
}

interface RateFormValues {
  currency_code: string;
  rate_type: string;
  effective_date: Dayjs;
  rate: number;
  source?: string | null;
  remark?: string | null;
}

export function Currencies() {
  const { t } = useTranslation();
  // 纵深防御：数据库侧已由 deploy_67 的 RESTRICTIVE 租户策略收敛，
  // 这里显式再带一次 tenant_id，避免 PERMISSIVE 的 super_admin 分支被改回来时
  // 页面又变成「所有租户的币别混在一起」（历史上表现为每个币种出现两份）。
  const { user } = useAuth();
  const tenantId = user?.tenantId ?? null;

  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [ratesLoading, setRatesLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("currencies");

  const [keyword, setKeyword] = useState("");
  const [rateCurrencyFilter, setRateCurrencyFilter] = useState<string | undefined>(undefined);

  const [isCurrencyModalOpen, setIsCurrencyModalOpen] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState<Currency | null>(null);
  const [currencyForm] = Form.useForm<CurrencyFormValues>();

  const [isRateModalOpen, setIsRateModalOpen] = useState(false);
  const [editingRate, setEditingRate] = useState<ExchangeRate | null>(null);
  const [fetchingRate, setFetchingRate] = useState(false);
  const [rateForm] = Form.useForm<RateFormValues>();

  const fetchCurrencies = useCallback(async () => {
    try {
      setLoading(true);
      const query = supabase
        .from(CURRENCY_TABLE)
        .select("*")
        .eq("is_deleted", "n")
        .order("sort_order")
        .order("id");
      const { data, error } = await (tenantId === null
        ? query
        : query.eq("tenant_id", tenantId));
      if (error) throw error;
      setCurrencies(data || []);
    } catch (error) {
      console.error("Error fetching currencies:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setLoading(false);
    }
  }, [t, tenantId]);

  const fetchRates = useCallback(async () => {
    try {
      setRatesLoading(true);
      const query = supabase
        .from(EXCHANGE_RATE_TABLE)
        .select("*")
        .eq("is_deleted", "n")
        .order("effective_date", { ascending: false })
        .order("id", { ascending: false });
      const { data, error } = await (tenantId === null
        ? query
        : query.eq("tenant_id", tenantId));
      if (error) throw error;
      setRates(data || []);
    } catch (error) {
      console.error("Error fetching exchange rates:", error);
      message.error(t("common.fetchFailed"));
    } finally {
      setRatesLoading(false);
    }
  }, [t, tenantId]);

  useEffect(() => {
    void fetchCurrencies();
    void fetchRates();
  }, [fetchCurrencies, fetchRates]);

  const baseCurrency = useMemo(
    () => currencies.find((item) => item.is_base) ?? null,
    [currencies]
  );

  const currencyMap = useMemo(() => {
    const map = new Map<string, Currency>();
    currencies.forEach((item) => map.set(item.code, item));
    return map;
  }, [currencies]);

  const currencyOptions = useMemo(
    () => currencies.map((item) => ({ value: item.code, label: `${item.name} (${item.code})` })),
    [currencies]
  );

  /** 外币清单：本位币不维护汇率（恒为 1），表单与筛选都排除它 */
  const foreignCurrencyOptions = useMemo(
    () => currencyOptions.filter((item) => item.value !== baseCurrency?.code),
    [currencyOptions, baseCurrency]
  );

  const filteredCurrencies = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return currencies;
    return currencies.filter(
      (item) =>
        item.code.toLowerCase().includes(kw) ||
        item.name.toLowerCase().includes(kw) ||
        (item.symbol ?? "").toLowerCase().includes(kw)
    );
  }, [currencies, keyword]);

  const filteredRates = useMemo(() => {
    if (!rateCurrencyFilter) return rates;
    return rates.filter((item) => item.currency_code === rateCurrencyFilter);
  }, [rates, rateCurrencyFilter]);

  // ---------------------------------------------------------------- 币别
  const handleAddCurrency = () => {
    setEditingCurrency(null);
    currencyForm.setFieldsValue({
      code: "",
      name: "",
      symbol: "",
      decimal_places: 2,
      status: "active",
      sort_order: (currencies.at(-1)?.sort_order ?? 0) + 1,
      remark: "",
    });
    setIsCurrencyModalOpen(true);
  };

  const handleEditCurrency = (record: Currency) => {
    setEditingCurrency(record);
    currencyForm.setFieldsValue({
      code: record.code,
      name: record.name,
      symbol: record.symbol ?? "",
      decimal_places: Number(record.decimal_places ?? 2),
      status: record.status ?? "active",
      sort_order: record.sort_order ?? 0,
      remark: record.remark ?? "",
    });
    setIsCurrencyModalOpen(true);
  };

  const handleSubmitCurrency = async (values: CurrencyFormValues) => {
    // 代码统一大写存储（库里有 chk_currency_code_upper 约束，前端先归一避免白跑一趟）
    const payload = { ...values, code: values.code.trim().toUpperCase() };
    try {
      if (editingCurrency) {
        await logWithTiming(t("currency.log.updateCurrency"), "UPDATE", async () => {
          const { error } = await supabase
            .from(CURRENCY_TABLE)
            .update(payload)
            .eq("id", editingCurrency.id);
          if (error) throw error;
        });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(t("currency.log.createCurrency"), "INSERT", async () => {
          const { error } = await supabase.from(CURRENCY_TABLE).insert([payload]);
          if (error) throw error;
        });
        message.success(t("common.createSuccess"));
      }

      setIsCurrencyModalOpen(false);
      currencyForm.resetFields();
      setEditingCurrency(null);
      await fetchCurrencies();
      await refreshCurrencyRegistry();
    } catch (error) {
      console.error("Error saving currency:", error);
      const text = String((error as { message?: string }).message ?? "");
      if (text.includes("duplicate key")) {
        message.error(t("currency.codeExists"));
      } else {
        message.error(t("common.saveFailed"));
      }
    }
  };

  const handleToggleCurrencyActive = async (record: Currency, checked: boolean) => {
    try {
      const { error } = await supabase
        .from(CURRENCY_TABLE)
        .update({ status: checked ? "active" : "inactive" })
        .eq("id", record.id);
      if (error) throw error;
      message.success(checked ? t("common.enabled") : t("common.disabled"));
      await fetchCurrencies();
      await refreshCurrencyRegistry();
    } catch (error) {
      console.error("Error toggling currency status:", error);
      message.error(t("common.saveFailed"));
    }
  };

  const handleSetBaseCurrency = async (record: Currency) => {
    try {
      await logWithTiming(t("currency.log.updateBase"), "UPDATE", async () => {
        const { error } = await supabase.rpc("set_base_currency", { p_code: record.code });
        if (error) throw error;
      });
      message.success(t("currency.setBaseSuccess", { code: record.code }));
      await fetchCurrencies();
      await refreshCurrencyRegistry();
    } catch (error) {
      console.error("Error setting base currency:", error);
      message.error(t("currency.setBaseFailed"));
    }
  };

  const handleDeleteCurrency = async (record: Currency) => {
    try {
      const { error } = await supabase
        .from(CURRENCY_TABLE)
        .update({ is_deleted: "y" })
        .eq("id", record.id);
      if (error) throw error;
      message.success(t("common.deleteSuccess"));
      await fetchCurrencies();
      await refreshCurrencyRegistry();
    } catch (error) {
      console.error("Error deleting currency:", error);
      const text = String((error as { message?: string }).message ?? "");
      if (text.includes("本位币") || text.includes("base")) {
        message.error(t("currency.deleteBase"));
      } else {
        message.error(t("common.deleteFailed"));
      }
    }
  };

  // ---------------------------------------------------------------- 汇率

  /**
   * 抓取中国货币网（CFETS）人民币汇率中间价并回填。
   *
   * 设计要点：
   *   · 只回填、不落库 —— 用户看过再保存。汇率是凭证折算依据，写错则总账金额已经错了；
   *   · 生效日期不自动改 —— CFETS 遇节假日顺延发布，抓到的可能是前一个工作日的价，
   *     成功提示里如实告知发布日期，由用户判断要不要调整 effective_date；
   *   · source 记 "CFETS"，与手工录入区分开，便于日后追溯每条汇率的来路。
   */
  const handleFetchCfetsRate = async () => {
    const code = rateForm.getFieldValue("currency_code") as string | undefined;
    if (!code) {
      message.warning(t("currency.fetchCfetsPickCurrency"));
      return;
    }
    try {
      setFetchingRate(true);
      const result = await fetchCfetsQuote({
        currency: code,
        base: baseCurrency?.code ?? "CNY",
        refresh: true,
      });
      const row = result.rows[0];
      if (!row) {
        message.warning(t("currency.fetchCfetsNotFound", { code }));
        return;
      }
      rateForm.setFieldValue("rate", row.rate);
      rateForm.setFieldValue("source", "CFETS");
      message.success(
        t("currency.fetchCfetsSuccess", {
          rate: formatRate(row.rate),
          date: result.publishedDate,
        })
      );
    } catch (error) {
      // 数据源故障（502）与参数错误（400）处置方式不同，把服务端原文一并带出来
      console.error("Error fetching CFETS quote:", error);
      const detail = String((error as { message?: string }).message ?? "");
      message.error(
        detail ? `${t("currency.fetchCfetsFailed")}：${detail}` : t("currency.fetchCfetsFailed")
      );
    } finally {
      setFetchingRate(false);
    }
  };

  const handleAddRate = () => {
    setEditingRate(null);
    rateForm.setFieldsValue({
      currency_code: rateCurrencyFilter ?? foreignCurrencyOptions[0]?.value,
      rate_type: "spot",
      effective_date: dayjs(),
      rate: 1,
      source: "",
      remark: "",
    });
    setIsRateModalOpen(true);
  };

  const handleEditRate = (record: ExchangeRate) => {
    setEditingRate(record);
    rateForm.setFieldsValue({
      currency_code: record.currency_code,
      rate_type: record.rate_type ?? "spot",
      effective_date: dayjs(record.effective_date),
      rate: Number(record.rate),
      source: record.source ?? "",
      remark: record.remark ?? "",
    });
    setIsRateModalOpen(true);
  };

  const handleSubmitRate = async (values: RateFormValues) => {
    const payload = {
      currency_code: values.currency_code,
      rate_type: values.rate_type,
      effective_date: values.effective_date.format("YYYY-MM-DD"),
      rate: values.rate,
      source: values.source ?? null,
      remark: values.remark ?? null,
    };
    try {
      if (editingRate) {
        await logWithTiming(t("currency.log.updateRate"), "UPDATE", async () => {
          const { error } = await supabase
            .from(EXCHANGE_RATE_TABLE)
            .update(payload)
            .eq("id", editingRate.id);
          if (error) throw error;
        });
        message.success(t("common.updateSuccess"));
      } else {
        await logWithTiming(t("currency.log.createRate"), "INSERT", async () => {
          const { error } = await supabase.from(EXCHANGE_RATE_TABLE).insert([payload]);
          if (error) throw error;
        });
        message.success(t("common.createSuccess"));
      }

      setIsRateModalOpen(false);
      rateForm.resetFields();
      setEditingRate(null);
      await fetchRates();
    } catch (error) {
      console.error("Error saving exchange rate:", error);
      const text = String((error as { message?: string }).message ?? "");
      if (text.includes("duplicate key")) {
        message.error(t("currency.rateExists"));
      } else if (text.includes("chk_fx_rate_positive")) {
        message.error(t("currency.form.ratePositive"));
      } else {
        message.error(t("common.saveFailed"));
      }
    }
  };

  const handleDeleteRate = async (id: number) => {
    try {
      const { error } = await supabase
        .from(EXCHANGE_RATE_TABLE)
        .update({ is_deleted: "y" })
        .eq("id", id);
      if (error) throw error;
      message.success(t("common.deleteSuccess"));
      await fetchRates();
    } catch (error) {
      console.error("Error deleting exchange rate:", error);
      message.error(t("common.deleteFailed"));
    }
  };

  const currencyColumns = [
    {
      title: t("common.code"),
      dataIndex: "code",
      key: "code",
      width: 100,
    },
    {
      title: t("common.name"),
      dataIndex: "name",
      key: "name",
      width: 140,
      render: (name: string, record: Currency) => (
        <Space size={6}>
          <span>{name}</span>
          {record.is_base && <Tag color="gold">{t("currency.baseTag")}</Tag>}
        </Space>
      ),
    },
    {
      title: t("currency.symbol"),
      dataIndex: "symbol",
      key: "symbol",
      width: 90,
      render: (symbol: string | null) => symbol || "-",
    },
    {
      title: t("currency.decimalPlaces"),
      dataIndex: "decimal_places",
      key: "decimal_places",
      width: 110,
      render: (value: number | null) => Number(value ?? 2),
    },
    {
      title: t("currency.rate"),
      key: "latest_rate",
      width: 150,
      render: (_: unknown, record: Currency) => {
        if (record.is_base) return t("currency.form.baseNotAllowed");
        const latest = rates.find((item) => item.currency_code === record.code);
        if (!latest) return "-";
        return t("currency.rateHint", {
          foreign: record.code,
          rate: formatRate(latest.rate),
          base: baseCurrency?.code ?? "",
        });
      },
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (status: string | null, record: Currency) => (
        <Switch
          checked={status !== "inactive"}
          size="small"
          disabled={!!record.is_base}
          onChange={(checked) => handleToggleCurrencyActive(record, checked)}
        />
      ),
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 250,
      render: (_: unknown, record: Currency) => (
        <Space size="small">
          {!record.is_base && (
            <Popconfirm
              title={t("currency.setBaseConfirm", { code: record.code })}
              description={<span style={{ maxWidth: 320, display: "inline-block" }}>{t("currency.setBaseWarning")}</span>}
              onConfirm={() => handleSetBaseCurrency(record)}
              okText={t("common.ok")}
              cancelText={t("common.cancel")}
            >
              <Button type="text" icon={<StarOutlined />}>
                {t("currency.setBase")}
              </Button>
            </Popconfirm>
          )}
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditCurrency(record)}>
            {t("common.edit")}
          </Button>
          <Popconfirm
            title={t("common.confirmDelete")}
            description={
              record.is_base ? t("currency.deleteBase") : t("currency.deleteConfirm")
            }
            onConfirm={() => handleDeleteCurrency(record)}
            okText={t("common.ok")}
            cancelText={t("common.cancel")}
            disabled={!!record.is_base}
          >
            <Button type="text" danger icon={<DeleteOutlined />} disabled={!!record.is_base}>
              {t("common.delete")}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const rateColumns = [
    {
      title: t("common.code"),
      dataIndex: "currency_code",
      key: "currency_code",
      width: 140,
      render: (code: string) => (
        <Space size={6}>
          <span>{code}</span>
          <span style={{ color: "var(--ant-color-text-secondary, #999)" }}>
            {currencyMap.get(code)?.name ?? ""}
          </span>
        </Space>
      ),
    },
    {
      title: t("currency.rateType"),
      dataIndex: "rate_type",
      key: "rate_type",
      width: 110,
      render: (value: string | null) =>
        RATE_TYPES.includes((value ?? "spot") as (typeof RATE_TYPES)[number])
          ? t(`currency.rateType.${value ?? "spot"}`)
          : value ?? "-",
    },
    {
      title: t("currency.effectiveDate"),
      dataIndex: "effective_date",
      key: "effective_date",
      width: 130,
    },
    {
      title: t("currency.rate"),
      dataIndex: "rate",
      key: "rate",
      width: 220,
      render: (value: number, record: ExchangeRate) =>
        t("currency.rateHint", {
          foreign: record.currency_code,
          rate: formatRate(value),
          base: baseCurrency?.code ?? "",
        }),
    },
    {
      title: t("currency.source"),
      dataIndex: "source",
      key: "source",
      width: 140,
      render: (value: string | null) => value || "-",
    },
    {
      title: t("currency.remark"),
      dataIndex: "remark",
      key: "remark",
      render: (value: string | null) => value || "-",
    },
    {
      title: t("common.actions"),
      key: "action",
      width: 150,
      render: (_: unknown, record: ExchangeRate) => (
        <Space size="middle">
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEditRate(record)}>
            {t("common.edit")}
          </Button>
          <Popconfirm
            title={t("common.confirmDelete")}
            description={t("currency.deleteRateConfirm")}
            onConfirm={() => handleDeleteRate(record.id)}
            okText={t("common.ok")}
            cancelText={t("common.cancel")}
          >
            <Button type="text" danger icon={<DeleteOutlined />}>
              {t("common.delete")}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card variant="borderless" title={t('currency.title')}>
      <Alert
        type="info"
        closable
        showIcon
        style={{ marginBottom: 12 }}
        message={t("currency.currentBase", { code: baseCurrency?.code ?? "CNY" })}
        description={t("currency.setBaseWarning")}
      />

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "currencies",
            label: t("currency.tabs.currencies"),
            children: (
              <SuperTable
                columns={currencyColumns}
                dataSource={filteredCurrencies}
                rowKey="id"
                loading={loading}
                storageKey="currencies"
                queryBar={
                  <Space>
                    <Input
                      allowClear
                      prefix={<SearchOutlined />}
                      placeholder={t("currency.searchPlaceholder")}
                      style={{ width: 240 }}
                      value={keyword}
                      onChange={(e) => setKeyword(e.target.value)}
                    />
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleAddCurrency}>
                      {t("currency.add")}
                    </Button>
                  </Space>
                }
                pagination={{
                  pageSize: 10,
                  showTotal: (total) => t("currency.totalCurrencies", { total }),
                }}
              />
            ),
          },
          {
            key: "rates",
            label: t("currency.tabs.rates"),
            children: (
              <SuperTable
                headerTitle={t("currency.tabs.rates")}
                columns={rateColumns}
                dataSource={filteredRates}
                rowKey="id"
                loading={ratesLoading}
                storageKey="exchangeRates"
                queryBar={
                  <Space>
                    <Select
                      allowClear
                      placeholder={t("currency.filter.currencyPlaceholder")}
                      style={{ width: 220 }}
                      value={rateCurrencyFilter}
                      onChange={(value) => setRateCurrencyFilter(value)}
                    >
                      {foreignCurrencyOptions.map((item) => (
                        <Option key={item.value} value={item.value}>
                          {item.label}
                        </Option>
                      ))}
                    </Select>
                    <Button
                      type="primary"
                      icon={<PlusOutlined />}
                      onClick={handleAddRate}
                      disabled={foreignCurrencyOptions.length === 0}
                    >
                      {t("currency.addRate")}
                    </Button>
                  </Space>
                }
                pagination={{
                  pageSize: 10,
                  showTotal: (total) => t("currency.totalRates", { total }),
                }}
              />
            ),
          },
        ]}
      />

      <SimpleModal
        title={editingCurrency ? t("currency.edit") : t("currency.add")}
        open={isCurrencyModalOpen}
        onCancel={() => {
          setIsCurrencyModalOpen(false);
          currencyForm.resetFields();
          setEditingCurrency(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsCurrencyModalOpen(false);
                currencyForm.resetFields();
                setEditingCurrency(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => currencyForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={480}
      >
        <Form
          form={currencyForm}
          layout="vertical"
          onFinish={handleSubmitCurrency}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label={t("common.code")}
            name="code"
            tooltip={t("currency.form.codeImmutable")}
            rules={[
              { required: true, message: t("currency.form.codeRequired") },
              {
                pattern: /^[A-Za-z][A-Za-z0-9]{1,9}$/,
                message: t("currency.form.codeInvalid"),
              },
            ]}
          >
            <Input
              placeholder={t("currency.form.codePlaceholder")}
              disabled={!!editingCurrency}
              maxLength={10}
            />
          </Form.Item>
          <Form.Item
            label={t("common.name")}
            name="name"
            rules={[{ required: true, message: t("currency.form.nameRequired") }]}
          >
            <Input placeholder={t("currency.form.namePlaceholder")} />
          </Form.Item>
          <Form.Item label={t("currency.symbol")} name="symbol">
            <Input placeholder={t("currency.form.symbolPlaceholder")} maxLength={10} />
          </Form.Item>
          <Form.Item
            label={t("currency.decimalPlaces")}
            name="decimal_places"
            tooltip={t("currency.decimalPlacesHint")}
            rules={[{ required: true, message: t("currency.form.decimalPlacesRequired") }]}
          >
            <InputNumber style={{ width: "100%" }} min={0} max={4} precision={0} />
          </Form.Item>
          <Form.Item label={t("common.sortOrder")} name="sort_order">
            <InputNumber style={{ width: "100%" }} precision={0} />
          </Form.Item>
          <Form.Item label={t("common.status")} name="status">
            <Select>
              <Option value="active">{t("common.enabled")}</Option>
              <Option value="inactive">{t("common.disabled")}</Option>
            </Select>
          </Form.Item>
          <Form.Item label={t("currency.remark")} name="remark">
            <Input placeholder={t("currency.remark")} />
          </Form.Item>
        </Form>
      </SimpleModal>

      <SimpleModal
        title={editingRate ? t("currency.editRate") : t("currency.addRate")}
        open={isRateModalOpen}
        onCancel={() => {
          setIsRateModalOpen(false);
          rateForm.resetFields();
          setEditingRate(null);
        }}
        footer={
          <Space>
            <Button
              onClick={() => {
                setIsRateModalOpen(false);
                rateForm.resetFields();
                setEditingRate(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="primary" onClick={() => rateForm.submit()}>
              {t("common.save")}
            </Button>
          </Space>
        }
        width={480}
      >
        <Form
          form={rateForm}
          layout="vertical"
          onFinish={handleSubmitRate}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label={t("currency.tabs.currencies")}
            name="currency_code"
            rules={[{ required: true, message: t("currency.form.currencyRequired") }]}
          >
            <Select
              placeholder={t("currency.form.currencyPlaceholder")}
              disabled={!!editingRate}
              showSearch
              optionFilterProp="children"
            >
              {foreignCurrencyOptions.map((item) => (
                <Option key={item.value} value={item.value}>
                  {item.label}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t("currency.rateType")}
            name="rate_type"
            rules={[{ required: true, message: t("currency.form.rateTypeRequired") }]}
          >
            <Select>
              {RATE_TYPES.map((type) => (
                <Option key={type} value={type}>
                  {t(`currency.rateType.${type}`)}
                </Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t("currency.effectiveDate")}
            name="effective_date"
            rules={[{ required: true, message: t("currency.form.effectiveDateRequired") }]}
          >
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label={
              <Space size={8}>
                <span>{t("currency.rate")}</span>
                <Tooltip title={t("currency.fetchCfetsTooltip")}>
                  <Button
                    size="small"
                    type="link"
                    style={{ padding: 0, height: "auto" }}
                    icon={<CloudDownloadOutlined />}
                    loading={fetchingRate}
                    onClick={handleFetchCfetsRate}
                  >
                    {t("currency.fetchCfets")}
                  </Button>
                </Tooltip>
              </Space>
            }
            name="rate"
            tooltip={t("currency.rateTooltip")}
            rules={[
              { required: true, message: t("currency.form.rateRequired") },
              {
                validator: (_, value: number) =>
                  Number(value) > 0
                    ? Promise.resolve()
                    : Promise.reject(new Error(t("currency.form.ratePositive"))),
              },
            ]}
          >
            <InputNumber
              style={{ width: "100%" }}
              min={0.00000001}
              step={0.0001}
              precision={8}
              prefix={<DollarOutlined />}
            />
          </Form.Item>
          <Form.Item label={t("currency.source")} name="source">
            <Input placeholder={t("currency.sourcePlaceholder")} />
          </Form.Item>
          <Form.Item label={t("currency.remark")} name="remark">
            <Input placeholder={t("currency.remark")} />
          </Form.Item>
        </Form>
      </SimpleModal>
    </Card>
  );
}

export default Currencies;
