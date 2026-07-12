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

  return {
    ...defaultAISettings,
    ...record,
    providers: safeProviders,
    activeProviderId,
    temperature: typeof record.temperature === 'number' ? record.temperature : defaultAISettings.temperature,
    maxContextMessages:
      typeof record.maxContextMessages === 'number'
        ? record.maxContextMessages
        : defaultAISettings.maxContextMessages,
  };
}

export async function fetchAISettings() {
  const { data, error } = await supabase
    .from('sys_config')
    .select('config_json')
    .eq('category_code', 'ai')
    .eq('is_deleted', 'n')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return normalizeAISettings(data?.config_json);
}

export async function saveAISettings(config: AISettingsConfig) {
  const { error } = await supabase
    .from('sys_config')
    .upsert(
      {
        category_code: 'ai',
        category_name: 'AI设置',
        description: 'AI 助手、大模型列表和生成参数。密钥建议放在服务端环境变量。',
        config_json: config,
        status: '1',
        sort_order: 5,
        is_deleted: 'n',
      },
      { onConflict: 'category_code' },
    );

  if (error) {
    throw error;
  }
}
