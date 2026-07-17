import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
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
import { logWithTiming } from '../../utils/logger';
import { createProvider, defaultAISettings, normalizeAISettings, providerTypeOptions } from '../../utils/aiConfig';

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

type FieldKind = 'text' | 'number' | 'switch' | 'select' | 'textarea';

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
    name: '基础设置',
    description: '企业资料、默认语言、时区和单据号规则等全局基础参数。',
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
      { name: 'companyName', label: '企业名称', kind: 'text' },
      { name: 'companyCode', label: '企业编码', kind: 'text' },
      {
        name: 'timezone',
        label: '默认时区',
        kind: 'select',
        options: [
          { label: 'Asia/Shanghai', value: 'Asia/Shanghai' },
          { label: 'UTC', value: 'UTC' },
        ],
      },
      {
        name: 'language',
        label: '默认语言',
        kind: 'select',
        options: [
          { label: '简体中文', value: 'zh-CN' },
          { label: 'English', value: 'en-US' },
        ],
      },
      { name: 'dateFormat', label: '日期格式', kind: 'text' },
      { name: 'documentNoPrefix', label: '单据号前缀', kind: 'text' },
      { name: 'enableOperationLog', label: '启用操作日志', kind: 'switch' },
    ],
  },
  {
    code: 'finance',
    name: '财务设置',
    description: '本位币、税率、会计期间和凭证过账控制。',
    defaults: {
      baseCurrency: 'CNY',
      defaultTaxRate: 13,
      accountingYearStartMonth: 1,
      voucherAutoPost: false,
      allowBackdatedVoucher: false,
      amountPrecision: 2,
    },
    fields: [
      { name: 'baseCurrency', label: '本位币', kind: 'text' },
      { name: 'defaultTaxRate', label: '默认税率(%)', kind: 'number', min: 0, max: 100, step: 0.01 },
      { name: 'accountingYearStartMonth', label: '会计年度起始月', kind: 'number', min: 1, max: 12 },
      { name: 'voucherAutoPost', label: '凭证自动过账', kind: 'switch' },
      { name: 'allowBackdatedVoucher', label: '允许补录历史凭证', kind: 'switch' },
      { name: 'amountPrecision', label: '金额小数位', kind: 'number', min: 0, max: 6 },
    ],
  },
  {
    code: 'manufacturing',
    name: '制造设置',
    description: 'MRP、BOM、工艺路线和生产订单的默认行为。',
    defaults: {
      mrpPlanningHorizonDays: 30,
      defaultLeadTimeDays: 7,
      allowBomVersionOverlap: false,
      requireRoutingForProduction: true,
      autoReserveMaterials: false,
      scrapRatePrecision: 4,
    },
    fields: [
      { name: 'mrpPlanningHorizonDays', label: 'MRP计划展望期(天)', kind: 'number', min: 1 },
      { name: 'defaultLeadTimeDays', label: '默认提前期(天)', kind: 'number', min: 0 },
      { name: 'allowBomVersionOverlap', label: '允许BOM版本重叠', kind: 'switch' },
      { name: 'requireRoutingForProduction', label: '生产订单必须选择工艺路线', kind: 'switch' },
      { name: 'autoReserveMaterials', label: '自动预留物料', kind: 'switch' },
      { name: 'scrapRatePrecision', label: '损耗率小数位', kind: 'number', min: 0, max: 6 },
    ],
  },
  {
    code: 'quality',
    name: '检验设置',
    description: '来料、生产和出货检验策略。',
    defaults: {
      incomingInspectionEnabled: true,
      productionInspectionEnabled: true,
      outgoingInspectionEnabled: false,
      defaultSamplingRate: 10,
      blockUnqualifiedStock: true,
      autoCreateInspectionTask: true,
    },
    fields: [
      { name: 'incomingInspectionEnabled', label: '启用来料检验', kind: 'switch' },
      { name: 'productionInspectionEnabled', label: '启用生产检验', kind: 'switch' },
      { name: 'outgoingInspectionEnabled', label: '启用出货检验', kind: 'switch' },
      { name: 'defaultSamplingRate', label: '默认抽检比例(%)', kind: 'number', min: 0, max: 100 },
      { name: 'blockUnqualifiedStock', label: '不合格品禁止出库', kind: 'switch' },
      { name: 'autoCreateInspectionTask', label: '自动生成检验任务', kind: 'switch' },
    ],
  },
  {
    code: 'ai',
    name: 'AI设置',
    description: 'AI 助手、大模型列表和生成参数。API Key 会随系统设置保存，请仅给可信管理员开放该表权限。',
    defaults: defaultAISettings as unknown as ConfigObject,
    fields: [
      { name: 'enabled', label: '启用AI助手', kind: 'switch' },
      { name: 'temperature', label: '温度', kind: 'number', min: 0, max: 2, step: 0.1 },
      { name: 'redactSensitiveData', label: '发送前脱敏敏感数据', kind: 'switch' },
      { name: 'maxContextMessages', label: '最大上下文消息数', kind: 'number', min: 1, max: 50 },
    ],
  },
];

const categoryMap = new Map(settingCategories.map((category) => [category.code, category]));

function mergeDefaults(category: SettingCategory, config?: ConfigObject | null) {
  return {
    ...category.defaults,
    ...(config || {}),
  };
}

function renderField(field: SettingField) {
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
  const [form] = Form.useForm<ConfigObject>();
  const [configs, setConfigs] = useState<SysConfig[]>([]);
  const [activeKey, setActiveKey] = useState(settingCategories[0].code);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<ConfigObject>(settingCategories[0].defaults);

  const activeCategory = categoryMap.get(activeKey) || settingCategories[0];
  const activeConfig = useMemo(
    () => configs.find((item) => item.category_code === activeCategory.code),
    [activeCategory.code, configs],
  );
  const watchedProviders = Form.useWatch('providers', form) as Array<{ id?: string; name?: string; model?: string }> | undefined;

  const fetchConfigs = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('sys_config')
        .select('id, category_code, category_name, config_json, description, status, sort_order')
        .eq('is_deleted', 'n')
        .order('sort_order', { ascending: true });

      if (error) throw error;
      setConfigs((data || []) as SysConfig[]);
    } catch (error) {
      message.error('获取系统设置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchConfigs();
  }, []);

  useEffect(() => {
    const values = mergeDefaults(activeCategory, activeConfig?.config_json);
    form.setFieldsValue(values);
    setPreview(values);
  }, [activeCategory, activeConfig, form]);

  const handleSave = async () => {
    const values = await form.validateFields();
    const configJson = activeCategory.code === 'ai' ? normalizeAISettings(values) : values;
    const payload = {
      category_code: activeCategory.code,
      category_name: activeCategory.name,
      description: activeCategory.description,
      config_json: configJson,
      status: '1',
      sort_order: settingCategories.findIndex((item) => item.code === activeCategory.code) + 1,
      is_deleted: 'n',
    };

    setSaving(true);
    try {
      await logWithTiming(
        '保存系统设置',
        'UPSERT sys_config',
        async () => {
          const { error } = await supabase
            .from('sys_config')
            .upsert(payload, { onConflict: 'category_code' });
          if (error) throw error;
        },
        { category_code: activeCategory.code },
      );
      message.success('设置已保存');
      setPreview(configJson as unknown as ConfigObject);
      fetchConfigs();
    } catch (error) {
      message.error('保存系统设置失败');
    } finally {
      setSaving(false);
    }
  };

  const renderAIProviderSettings = () => {
    if (activeCategory.code !== 'ai') {
      return null;
    }

    const providerOptions = (watchedProviders || []).map((provider, index) => ({
      label: `${provider?.name || `模型${index + 1}`}${provider?.model ? ` / ${provider.model}` : ''}`,
      value: provider?.id || '',
    })).filter((option) => option.value);

    return (
      <>
        <Divider>大模型列表</Divider>
        <Form.Item name="activeProviderId" label="默认使用模型" rules={[{ required: true, message: '请选择默认模型' }]}>
          <Select options={providerOptions} placeholder="请选择默认使用的大模型" />
        </Form.Item>
        <Form.List name="providers">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: '100%' }} size={12}>              
                <Space direction="vertical" style={{ width: '100%' }} size={12}>
                  {fields.map((field) => (
                    <Card
                      key={field.key}
                      size="small"
                      title={`模型 ${field.name + 1}`}
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
                          <Form.Item name={[field.name, 'name']} label="显示名称" rules={[{ required: true }]}>
                            <Input placeholder="如 Ollama 本地" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item name={[field.name, 'apiType']} label="接口类型" rules={[{ required: true }]}>
                            <Select options={providerTypeOptions} />
                          </Form.Item>
                        </Col>
                        <Col xs={24}>
                          <Form.Item name={[field.name, 'endpoint']} label="接口地址">
                            <Input placeholder="如 http://localhost:11434/api/chat" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item name={[field.name, 'model']} label="模型 ID" rules={[{ required: true }]}>
                            <Input placeholder="如 qwen2.5、deepseek-r1" />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={12}>
                          <Form.Item name={[field.name, 'apiKey']} label="API Key">
                            <Input.Password placeholder="可选，Ollama 本地通常不用填" />
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
                新增大模型
              </Button>
            </Space>
          )}
        </Form.List>
      </>
    );
  };
  const items = settingCategories.map((category) => ({
    key: category.code,
    label: category.name,
  }));

  return (
    <Card
      variant="borderless"
      title="系统设置"
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={fetchConfigs}
            loading={loading}
          >
            刷新
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={saving}
          >
            保存设置
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        closable
        message="系统设置按分类保存到 sys_config.config_json。AI API Key 会随系统设置保存，请只给可信管理员开放 sys_config 的读取和维护权限。"
      />

      <Tabs activeKey={activeKey} items={items} onChange={setActiveKey} />
      <div
        style={{
          maxHeight: "calc(100vh - 420px)",
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
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
                      {renderField(field)}
                    </Col>
                  ))}
                </Row>
                {renderAIProviderSettings()}
              </Form>
            </Col>

            <Col xs={24} lg={10}>
              <Card size="small" title="JSON 预览">
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
  );
}
