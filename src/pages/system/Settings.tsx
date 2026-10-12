import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  ConfigProvider,
  Divider,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { supabase } from '../../utils/supabase';
import { useCurrencyRegistry } from '../../utils/money';
import { logWithTiming } from '../../utils/logger';
import { createProvider, defaultAISettings, normalizeAISettings, providerTypeOptions } from '../../utils/aiConfig';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

type ConfigValue = string | number | boolean | null | ConfigObject | ConfigValue[];
type ConfigObject = { [key: string]: ConfigValue };

interface SysConfig {
  id: number;
  category_code: string;
  category_name: string;
  config_json: ConfigObject | null;
  description: string | null;
  status: string | null;
  sort_order: number | null;
}

type FieldKind = 'text' | 'number' | 'switch' | 'select' | 'textarea' | 'readonly';

interface SettingField {
  name: string;
  label: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string | number | boolean }>;
  placeholder?: string;
}

interface SettingCategory {
  code: string;
  name: string;
  description: string;
  defaults: ConfigObject;
  fields: SettingField[];
}

const settingCategories: SettingCategory[] = [
  {
    code: 'basic',
    name: 'settings.categories.basic.name',
    description: 'settings.categories.basic.description',
    defaults: {
      companyName: 'OPERP',
      companyCode: 'ERP',
      timezone: 'Asia/Shanghai',
      language: 'zh-CN',
      dateFormat: 'YYYY-MM-DD',
      documentNoPrefix: 'ERP',
      enableOperationLog: true,
    },
    fields: [
      { name: 'companyName', label: 'settings.fields.companyName', kind: 'text' },
      { name: 'companyCode', label: 'settings.fields.companyCode', kind: 'text' },
      {
        name: 'timezone',
        label: 'settings.fields.timezone',
        kind: 'select',
        options: [
          { label: 'Asia/Shanghai', value: 'Asia/Shanghai' },
          { label: 'UTC', value: 'UTC' },
        ],
      },
      {
        name: 'language',
        label: 'settings.fields.language',
        kind: 'select',
        options: [
          { label: 'language.zhCN', value: 'zh-CN' },
          { label: 'English', value: 'en-US' },
        ],
      },
      { name: 'dateFormat', label: 'settings.fields.dateFormat', kind: 'text' },
      { name: 'documentNoPrefix', label: 'settings.fields.documentNoPrefix', kind: 'text' },
      { name: 'enableOperationLog', label: 'settings.fields.enableOperationLog', kind: 'switch' },
    ],
  },
  {
    code: 'finance',
    name: 'settings.categories.finance.name',
    description: 'settings.categories.finance.description',
    defaults: {
      baseCurrency: 'CNY',
      defaultTaxRate: 13,
      accountingYearStartMonth: 1,
      voucherAutoPost: false,
      allowBackdatedVoucher: false,
      amountPrecision: 2,
    },
    fields: [
      // 本位币的唯一真相源是 erp_currencies.is_base（经 current_base_currency() 读取），
      // 这里只做只读展示：改了也不会生效（is_base 优先级高于 sys_config 的同名键），
      // 反而会让人误以为切换成功。切换入口只保留在「币别管理」。
      { name: 'baseCurrency', label: 'settings.fields.baseCurrency', kind: 'readonly' },
      { name: 'defaultTaxRate', label: 'settings.fields.defaultTaxRate', kind: 'number', min: 0, max: 100, step: 0.01 },
      { name: 'accountingYearStartMonth', label: 'settings.fields.accountingYearStartMonth', kind: 'number', min: 1, max: 12 },
      { name: 'voucherAutoPost', label: 'settings.fields.voucherAutoPost', kind: 'switch' },
      { name: 'allowBackdatedVoucher', label: 'settings.fields.allowBackdatedVoucher', kind: 'switch' },
      { name: 'amountPrecision', label: 'settings.fields.amountPrecision', kind: 'number', min: 0, max: 6 },
    ],
  },
  {
    code: 'manufacturing',
    name: 'settings.categories.manufacturing.name',
    description: 'settings.categories.manufacturing.description',
    defaults: {
      mrpPlanningHorizonDays: 30,
      defaultLeadTimeDays: 7,
      allowBomVersionOverlap: false,
      requireRoutingForProduction: true,
      autoReserveMaterials: false,
      scrapRatePrecision: 4,
    },
    fields: [
      { name: 'mrpPlanningHorizonDays', label: 'settings.fields.mrpPlanningHorizonDays', kind: 'number', min: 1 },
      { name: 'defaultLeadTimeDays', label: 'settings.fields.defaultLeadTimeDays', kind: 'number', min: 0 },
      { name: 'allowBomVersionOverlap', label: 'settings.fields.allowBomVersionOverlap', kind: 'switch' },
      { name: 'requireRoutingForProduction', label: 'settings.fields.requireRoutingForProduction', kind: 'switch' },
      { name: 'autoReserveMaterials', label: 'settings.fields.autoReserveMaterials', kind: 'switch' },
      { name: 'scrapRatePrecision', label: 'settings.fields.scrapRatePrecision', kind: 'number', min: 0, max: 6 },
    ],
  },
  {
    code: 'quality',
    name: 'settings.categories.quality.name',
    description: 'settings.categories.quality.description',
    defaults: {
      incomingInspectionEnabled: true,
      productionInspectionEnabled: true,
      outgoingInspectionEnabled: false,
      defaultSamplingRate: 10,
      blockUnqualifiedStock: true,
      autoCreateInspectionTask: true,
    },
    fields: [
      { name: 'incomingInspectionEnabled', label: 'settings.fields.incomingInspectionEnabled', kind: 'switch' },
      { name: 'productionInspectionEnabled', label: 'settings.fields.productionInspectionEnabled', kind: 'switch' },
      { name: 'outgoingInspectionEnabled', label: 'settings.fields.outgoingInspectionEnabled', kind: 'switch' },
      { name: 'defaultSamplingRate', label: 'settings.fields.defaultSamplingRate', kind: 'number', min: 0, max: 100 },
      { name: 'blockUnqualifiedStock', label: 'settings.fields.blockUnqualifiedStock', kind: 'switch' },
      { name: 'autoCreateInspectionTask', label: 'settings.fields.autoCreateInspectionTask', kind: 'switch' },
    ],
  },
  {
    code: 'ai',
    name: 'settings.categories.ai.name',
    description: 'settings.categories.ai.description',
    defaults: defaultAISettings as unknown as ConfigObject,
    fields: [
      { name: 'enabled', label: 'settings.fields.aiEnabled', kind: 'switch' },
      { name: 'temperature', label: 'settings.fields.temperature', kind: 'number', min: 0, max: 2, step: 0.1 },
      { name: 'redactSensitiveData', label: 'settings.fields.redactSensitiveData', kind: 'switch' },
      { name: 'maxContextMessages', label: 'settings.fields.maxContextMessages', kind: 'number', min: 1, max: 50 },
    ],
  },
];

function mergeDefaults(category: SettingCategory, config?: ConfigObject | null) {
  return {
    ...category.defaults,
    ...(config || {}),
  };
}

function renderField(field: SettingField, extraNode?: ReactNode) {
  if (field.kind === 'switch') {
    return (
      <Form.Item key={field.name} name={field.name} label={field.label} valuePropName="checked">
        <Switch />
      </Form.Item>
    );
  }

  if (field.kind === 'number') {
    return (
      <Form.Item key={field.name} name={field.name} label={field.label}>
        <InputNumber min={field.min} max={field.max} step={field.step} style={{ width: '100%' }} />
      </Form.Item>
    );
  }

  if (field.kind === 'select') {
    return (
      <Form.Item key={field.name} name={field.name} label={field.label}>
        <Select options={field.options} />
      </Form.Item>
    );
  }

  if (field.kind === 'readonly') {
    return (
      <Form.Item key={field.name} name={field.name} label={field.label} extra={extraNode}>
        <Input readOnly />
      </Form.Item>
    );
  }

  if (field.kind === 'textarea') {
    return (
      <Form.Item key={field.name} name={field.name} label={field.label}>
        <Input.TextArea rows={4} placeholder={field.placeholder} />
      </Form.Item>
    );
  }

  return (
    <Form.Item key={field.name} name={field.name} label={field.label}>
      <Input placeholder={field.placeholder} />
    </Form.Item>
  );
}

export function Settings() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  // 本位币只展示、不编辑：权威值来自 current_base_currency()（即 erp_currencies.is_base）
  const { baseCurrency, loaded: currencyLoaded } = useCurrencyRegistry();
  const localizedCategories = useMemo(() => settingCategories.map((category) => ({
    ...category,
    name: t(category.name),
    description: t(category.description),
    fields: category.fields.map((field) => ({
      ...field,
      label: t(field.label),
      options: field.options?.map((option) => ({
        ...option,
        label: typeof option.label === 'string' && option.label.includes('.') ? t(option.label) : option.label,
      })),
    })),
  })), [t, i18n.resolvedLanguage]);
  const categoryMap = useMemo(
    () => new Map(localizedCategories.map((category) => [category.code, category])),
    [localizedCategories],
  );
  const [form] = Form.useForm<ConfigObject>();
  const [configs, setConfigs] = useState<SysConfig[]>([]);
  const [activeKey, setActiveKey] = useState(settingCategories[0].code);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<ConfigObject>(settingCategories[0].defaults);

  const activeCategory = categoryMap.get(activeKey) || localizedCategories[0];
  const activeConfig = useMemo(
    () => configs.find((item) => item.category_code === activeCategory.code),
    [activeCategory.code, configs],
  );
  const watchedProviders = Form.useWatch('providers', form) as Array<{ id?: string; name?: string; model?: string }> | undefined;

  const fetchConfigs = async () => {
    setLoading(true);
    try {
      // 读覆盖视图：同一 category_code 可能同时有平台基线行和本租户私有行，
      // 查原表会拿到 2 行；视图保证私有行覆盖基线行，每个编码只有一条。
      const { data, error } = await supabase
        .from('vw_sys_config_effective')
        .select('id, category_code, category_name, config_json, description, status, sort_order')
        .order('sort_order', { ascending: true });

      if (error) throw error;
      setConfigs((data || []) as SysConfig[]);
    } catch (error) {
      message.error(t('settings.messages.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfigs();
  }, []);

  useEffect(() => {
    const values = mergeDefaults(activeCategory, activeConfig?.config_json);
    // 财务分类：本位币以币别管理为准，避免把 sys_config 里可能过期的旧值呈到界面上。
    // 只认 loaded 之后的值 —— 未加载时仍是兜底的 CNY，拿来覆盖会短暂显示错值。
    if (activeCategory.code === 'finance' && currencyLoaded && baseCurrency) {
      values.baseCurrency = baseCurrency;
    }
    form.setFieldsValue(values);
    setPreview(values);
  }, [activeCategory, activeConfig, form, baseCurrency, currencyLoaded]);

  const handleSave = async () => {
    const values = await form.validateFields();
    const configJson = activeCategory.code === 'ai' ? normalizeAISettings(values) : values;
    const canonicalCategory = settingCategories.find((category) => category.code === activeCategory.code) || settingCategories[0];
    const zh = i18n.getFixedT('zh-CN');
    const payload = {
      p_category_code: activeCategory.code,
      p_category_name: zh(canonicalCategory.name),
      p_description: zh(canonicalCategory.description),
      p_config_json: configJson,
      p_status: '1',
      p_sort_order: settingCategories.findIndex((item) => item.code === activeCategory.code) + 1,
    };

    setSaving(true);
    try {
      await logWithTiming(
        t('settings.messages.saveAction'),
        'RPC save_tenant_config',
        async () => {
          // 不用 upsert：唯一键已改成 (tenant_id, category_code) 的部分索引，
          // onConflict 命中不了。RPC 内部按「有私有行更新 / 无则基于基线建副本」处理。
          const { error } = await supabase.rpc('save_tenant_config', payload);
          if (error) throw error;
        },
        { category_code: activeCategory.code },
      );
      message.success(t('settings.messages.saved'));
      setPreview(configJson as unknown as ConfigObject);
      fetchConfigs();
    } catch (error) {
      message.error(t('settings.messages.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const renderAIProviderSettings = () => {
    if (activeCategory.code !== 'ai') {
      return null;
    }

    const providerOptions = (watchedProviders || []).map((provider, index) => ({
      label: `${provider?.name || t('settings.providers.modelFallback', { number: index + 1 })}${provider?.model ? ` / ${provider.model}` : ''}`,
      value: provider?.id || '',
    })).filter((option) => option.value);

    return (
      <>
        <Divider>{t('settings.providers.list')}</Divider>
        <Form.Item name="activeProviderId" label={t('settings.providers.defaultModel')} rules={[{ required: true, message: t('settings.providers.selectDefault') }]}>
          <Select options={providerOptions} placeholder={t('settings.providers.selectPlaceholder')} />
        </Form.Item>
        <Form.Item
          name="embeddingProviderId"
          label={t('settings.providers.embeddingModel')}
          extra={t('settings.providers.embeddingHint')}
        >
          <Select
            allowClear
            options={providerOptions}
            placeholder={t('settings.providers.embeddingPlaceholder')}
          />
        </Form.Item>
        <Form.List name="providers">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: '100%' }} size={12}>              
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  {fields.map((field) => (
                    <Card
                      key={field.key}
                      size="small"
                      title={t('settings.providers.modelTitle', { number: field.name + 1 })}
                      extra={
                        <Button
                          danger
                          type="text"
                          icon={<DeleteOutlined />}
                          onClick={() => remove(field.name)}
                          disabled={fields.length <= 1}
                        />
                      }
                    >
                      <Form.Item name={[field.name, 'id']} hidden>
                        <Input />
                      </Form.Item>
                      <Row gutter={16}>
                        <Col xs={24} md={12}>
                          <Form.Item name={[field.name, 'name']} label={t('settings.providers.displayName')} rules={[{ required: true }]}>
                            <Input placeholder={t('settings.providers.displayNamePlaceholder')} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item name={[field.name, 'apiType']} label={t('settings.providers.apiType')} rules={[{ required: true }]}>
                            <Select options={providerTypeOptions.map((option) => ({ ...option, label: t(`settings.providers.${option.value}`) }))} />
                          </Form.Item>
                        </Col>
                        <Col xs={24}>
                          <Form.Item name={[field.name, 'endpoint']} label={t('settings.providers.endpoint')}>
                            <Input placeholder={t('settings.providers.endpointPlaceholder')} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item name={[field.name, 'model']} label={t('settings.providers.modelId')} rules={[{ required: true }]}>
                            <Input placeholder={t('settings.providers.modelIdPlaceholder')} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item name={[field.name, 'apiKey']} label="API Key">
                            <Input.Password placeholder={t('settings.providers.apiKeyOptional')} />
                          </Form.Item>
                        </Col>
                      </Row>
                    </Card>
                  ))}
                </Space>
              <Button
                block
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => {
                  const provider = createProvider();
                  add(provider);
                  const currentProviders = form.getFieldValue('providers') || [];
                  if (!form.getFieldValue('activeProviderId') && currentProviders.length === 0) {
                    form.setFieldValue('activeProviderId', provider.id);
                  }
                }}
              >
                {t('settings.providers.add')}
              </Button>
            </Space>
          )}
        </Form.List>
      </>
    );
  };
  const items = localizedCategories.map((category) => ({
    key: category.code,
    label: category.name,
  }));

  return (
    <ConfigProvider variant="underlined">
    <Card
      variant="borderless"
      title={t('settings.title')}
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={fetchConfigs}
            loading={loading}
          >
            {t('settings.refresh')}
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={saving}
          >
            {t('settings.save')}
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        closable
        message={t('settings.alert')}
      />

      <Tabs activeKey={activeKey} items={items} onChange={setActiveKey} />
      <div>
        <Spin spinning={loading}>
          <Row gutter={24}>
            <Col xs={24} lg={14}>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                {activeCategory.name}
                <Tag color="blue" style={{ marginLeft: 8 }}>
                  {activeCategory.code}
                </Tag>
              </Typography.Title>
              <Typography.Paragraph type="secondary">
                {activeCategory.description}
              </Typography.Paragraph>
              <Divider />
              <Form
                form={form}
                layout="vertical"
                onValuesChange={(_, values) =>
                  setPreview(values as ConfigObject)
                }
              >
                <Row gutter={16}>
                  {activeCategory.fields.map((field) => (
                    <Col xs={24} md={12} key={field.name}>
                      {renderField(
                        field,
                        field.name === 'baseCurrency' ? (
                          <Typography.Text type="secondary">
                            {t('settings.fields.baseCurrencyHint')}{' '}
                            <Typography.Link onClick={() => navigate('/system/currencies')}>
                              {t('menu.currencies')}
                            </Typography.Link>
                          </Typography.Text>
                        ) : undefined,
                      )}
                    </Col>
                  ))}
                </Row>
                {renderAIProviderSettings()}
              </Form>
            </Col>

            <Col xs={24} lg={10}>
              <Card size="small" title={t('settings.jsonPreview')}>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {JSON.stringify(preview, null, 2)}
                </pre>
              </Card>
            </Col>
          </Row>
        </Spin>
      </div>
    </Card>
    </ConfigProvider>
  );
}
