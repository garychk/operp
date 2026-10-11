import { supabase } from './supabase';

export type AIProviderType = 'proxy' | 'ollama';

export interface AIProviderConfig {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  apiType: AIProviderType;
  apiKey?: string;
}

export interface AISettingsConfig {
  enabled: boolean;
  providers: AIProviderConfig[];
  activeProviderId: string;
  /**
   * 知识库向量化专用模型的 provider id。空字符串 = 自动识别。
   *
   * 存在的意义：providers 是一张不分角色的扁平列表，后端只能按「模型名含 embed /
   * 接口地址含 embeddings」猜哪个是向量模型，遇到名字不规范的模型就会挑错。这里让
   * 用户在界面上把角色说清楚，后端优先采信。
   */
  embeddingProviderId: string;
  temperature: number;
  redactSensitiveData: boolean;
  maxContextMessages: number;
}

export const providerTypeOptions = [
  { label: '通用代理', value: 'proxy' },
  { label: 'Ollama', value: 'ollama' },
];

export const defaultProviders: AIProviderConfig[] = [
  {
    id: 'ollama',
    name: 'Ollama 本地',
    endpoint: 'http://localhost:11434/api/chat',
    model: 'qwen2.5',
    apiType: 'ollama',
  },
  {
    id: 'demo',
    name: '演示模式',
    endpoint: '',
    model: 'demo',
    apiType: 'proxy',
  },
];

export const defaultAISettings: AISettingsConfig = {
  enabled: true,
  providers: defaultProviders,
  activeProviderId: defaultProviders[0].id,
  // 空 = 自动识别（后端按模型名 / 接口地址特征挑 embedding 模型）
  embeddingProviderId: '',
  temperature: 0.3,
  redactSensitiveData: true,
  maxContextMessages: 12,
};

export const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createProvider = (): AIProviderConfig => ({
  id: createId(),
  name: 'Ollama 本地',
  endpoint: 'http://localhost:11434/api/chat',
  model: 'qwen2.5',
  apiType: 'ollama',
});

export const normalizeProvider = (provider: Partial<AIProviderConfig>): AIProviderConfig => ({
  id: provider.id || createId(),
  name: provider.name || '未命名模型',
  endpoint: provider.endpoint || '',
  model: provider.model || '',
  apiType: provider.apiType || 'proxy',
  apiKey: provider.apiKey,
});

export function normalizeAISettings(value: unknown): AISettingsConfig {
  const record = value && typeof value === 'object' ? (value as Partial<AISettingsConfig>) : {};
  const providers = Array.isArray(record.providers)
    ? record.providers.map((provider) => normalizeProvider(provider))
    : defaultAISettings.providers;
  const safeProviders = providers.length ? providers : defaultAISettings.providers;
  const activeProviderId = safeProviders.some((provider) => provider.id === record.activeProviderId)
    ? String(record.activeProviderId)
    : safeProviders[0].id;

  // 悬空 id（比如选完之后又把那条模型删了）一律归零成「自动识别」，
  // 否则后端会报「选定的向量模型不存在」，而用户在界面上看不出问题出在哪。
  const embeddingProviderId = safeProviders.some((provider) => provider.id === record.embeddingProviderId)
    ? String(record.embeddingProviderId)
    : '';

  return {
    ...defaultAISettings,
    ...record,
    providers: safeProviders,
    activeProviderId,
    embeddingProviderId,
    temperature: typeof record.temperature === 'number' ? record.temperature : defaultAISettings.temperature,
    maxContextMessages:
      typeof record.maxContextMessages === 'number'
        ? record.maxContextMessages
        : defaultAISettings.maxContextMessages,
  };
}

// 读覆盖视图而不是 sys_config 原表：同一 category_code 可能同时存在
// 平台基线行（tenant_id IS NULL）和本租户的私有行，直接查原表会拿到 2 行，
// .maybeSingle() 会报 PGRST116。视图保证私有行覆盖基线行，永远单行。
export async function fetchAISettings() {
  const { data, error } = await supabase
    .from('vw_sys_config_effective')
    .select('config_json')
    .eq('category_code', 'ai')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return normalizeAISettings(data?.config_json);
}

export async function saveAISettings(config: AISettingsConfig) {
  // 走 RPC 而不是 upsert：有私有行则更新，没有则基于基线行创建一条本租户的副本。
  // 直接 upsert 行不通 —— 唯一键已改成分租户的部分索引，onConflict 命中不了。
  const { error } = await supabase.rpc('save_tenant_config', {
    p_category_code: 'ai',
    p_config_json: config,
    p_category_name: 'AI设置',
    p_description: 'AI 助手、大模型列表和生成参数。密钥建议放在服务端环境变量。',
    p_sort_order: 5,
    p_status: '1',
  });

  if (error) {
    throw error;
  }
}
