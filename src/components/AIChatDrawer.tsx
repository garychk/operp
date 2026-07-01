import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BulbOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Bubble, Prompts, Sender, Welcome, XProvider } from '@ant-design/x';
import { Button, Drawer, Flex, Input, Modal, Select, Space, Typography, message } from 'antd';
import type { BubbleListRef } from '@ant-design/x/es/bubble';
import { buildERPAnalysisContext } from '../utils/aiAnalysisTools';
import { handleCreateSkill, type CreateFlowState } from '../utils/aiCreateTools';
import './AIChatDrawer.css';

interface AIChatDrawerProps {
  open: boolean;
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: 'loading' | 'success' | 'error';
}

type AIProviderType = 'proxy' | 'ollama';

interface AIProviderConfig {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  apiType: AIProviderType;
  apiKey?: string;
}

const STORAGE_KEY = 'erp-ai-chat-providers';
const ACTIVE_STORAGE_KEY = 'erp-ai-chat-active-provider';

const defaultProviders: AIProviderConfig[] = [
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

const providerTypeOptions = [
  { label: '通用代理', value: 'proxy' },
  { label: 'Ollama', value: 'ollama' },
];

const quickPrompts = [
  {
    key: 'erp',
    icon: <DatabaseOutlined />,
    label: 'ERP 数据助手',
    description: '帮我分析当前 ERP 业务数据应该从哪里入手',
  },
  {
    key: 'finance',
    icon: <BulbOutlined />,
    label: '财务建议',
    description: '帮我整理一份本月应收应付检查清单',
  },
  {
    key: 'inventory',
    icon: <SendOutlined />,
    label: '库存排查',
    description: '如何排查库存数量和采购入库不一致',
  },
  {
    key: 'business',
    icon: <SendOutlined />,
    label: '新增业务',
    description: '帮我新增一个销售订单、采购订单、客户、供应商、物料等',
  },
];

const createId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const createProvider = (): AIProviderConfig => ({
  id: createId(),
  name: 'Ollama 本地',
  endpoint: 'http://localhost:11434/api/chat',
  model: 'qwen2.5',
  apiType: 'ollama',
});

const normalizeProvider = (provider: Partial<AIProviderConfig>): AIProviderConfig => ({
  id: provider.id || createId(),
  name: provider.name || '未命名模型',
  endpoint: provider.endpoint || '',
  model: provider.model || '',
  apiType: provider.apiType || 'proxy',
  apiKey: provider.apiKey,
});

const loadProviders = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultProviders;
    }

    const parsed = JSON.parse(raw) as Partial<AIProviderConfig>[];
    return parsed.length ? parsed.map(normalizeProvider) : defaultProviders;
  } catch {
    return defaultProviders;
  }
};

const createRequestBody = (prompt: string, provider: AIProviderConfig) => {
  return {
    model: provider.model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
};

const stringifyReply = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (value == null) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map(stringifyReply).filter(Boolean).join('\n');
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const nestedContent = stringifyReply(record.content);
    if (nestedContent) {
      return nestedContent;
    }

    const nestedMessage = stringifyReply(record.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    return JSON.stringify(value, null, 2);
  }

  return String(value);
};

const getReplyContent = (data: unknown) => {
  const record = data as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? (record.choices as Record<string, unknown>[]) : [];
  const firstChoice = choices[0];

  return (
    stringifyReply(firstChoice?.message) ||
    stringifyReply(firstChoice?.delta) ||
    stringifyReply(firstChoice?.text) ||
    stringifyReply(record.reply) ||
    stringifyReply(record.content) ||
    stringifyReply(record.message) ||
    stringifyReply(record.response) ||
    stringifyReply(data)
  );
};

async function requestAIReply(prompt: string, provider: AIProviderConfig) {
  if (!provider.endpoint) {
    return [
      `${provider.name} 当前还没有配置接口地址。`,
      '',
      `你刚才问的是：“${prompt}”`,
      '',
      '点击底部齿轮可以新增或编辑多个大模型配置。Ollama 可直接使用 http://localhost:11434/api/chat。',
    ].join('\n');
  }

  const response = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify(createRequestBody(prompt, provider)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI 服务请求失败：${response.status}${errorText ? `，${errorText}` : ''}`);
  }

  const data = (await response.json()) as unknown;
  return getReplyContent(data) || 'AI 服务未返回文本内容。';
}

export function AIChatDrawer({ open, onClose }: AIChatDrawerProps) {
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingCreate, setPendingCreate] = useState<CreateFlowState | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [providers, setProviders] = useState<AIProviderConfig[]>(loadProviders);
  const [activeProviderId, setActiveProviderId] = useState(
    () => localStorage.getItem(ACTIVE_STORAGE_KEY) || providers[0]?.id || defaultProviders[0].id,
  );
  const listRef = useRef<BubbleListRef>(null);

  const activeProvider = useMemo(
    () => providers.find((item) => item.id === activeProviderId) || providers[0] || defaultProviders[0],
    [activeProviderId, providers],
  );

  const bubbleItems = useMemo(
    () =>
      messages.map((item) => ({
        key: item.id,
        role: item.role,
        content: item.content,
        loading: item.status === 'loading',
      })),
    [messages],
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
  }, [providers]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_STORAGE_KEY, activeProvider.id);
  }, [activeProvider.id]);

  const updateProvider = (id: string, patch: Partial<AIProviderConfig>) => {
    setProviders((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const addProvider = () => {
    const next = createProvider();
    setProviders((prev) => [...prev, next]);
    setActiveProviderId(next.id);
  };

  const deleteProvider = (id: string) => {
    setProviders((prev) => {
      const next = prev.filter((item) => item.id !== id);
      const safeNext = next.length ? next : defaultProviders;
      if (id === activeProviderId) {
        setActiveProviderId(safeNext[0].id);
      }
      return safeNext;
    });
  };

  const submitMessage = async (value: string) => {
    const prompt = value.trim();
    if (!prompt || loading) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content: prompt,
      status: 'success',
    };
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: '',
      status: 'loading',
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInputValue('');
    setLoading(true);
    window.setTimeout(() => listRef.current?.scrollTo({ top: 'bottom' }), 0);

    try {
      const createResult = await handleCreateSkill(prompt, pendingCreate);
      if (createResult.status !== 'ignored') {
        setPendingCreate(createResult.pending || null);
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantMessage.id
              ? {
                  ...item,
                  content: createResult.reply || '已处理创建指令。',
                  status: createResult.status === 'error' ? 'error' : 'success',
                }
              : item,
          ),
        );
        return;
      }

      const analysisContext = await buildERPAnalysisContext(prompt);
      if (analysisContext.domains.length) {
        message.info('已读取 ERP ' + analysisContext.domains.join(' / ') + ' 数据摘要');
      }
      const reply = await requestAIReply(analysisContext.prompt, activeProvider);
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantMessage.id
            ? { ...item, content: stringifyReply(reply), status: 'success' }
            : item,
        ),
      );
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'AI 服务暂时不可用。';
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantMessage.id
            ? { ...item, content: errorText, status: 'error' }
            : item,
        ),
      );
      message.error(errorText);
    } finally {
      setLoading(false);
      window.setTimeout(() => listRef.current?.scrollTo({ top: 'bottom' }), 0);
    }
  };

  return (
    <Drawer
      width={460}
      open={open}
      onClose={onClose}
      title="AI 智能对话"
      className="ai-chat-drawer"
      destroyOnClose={false}
    >
      <XProvider>
        <Flex vertical className="ai-chat-panel">
          <div className="ai-chat-messages">
            {messages.length > 0 ? (
              <Bubble.List
                ref={listRef}
                items={bubbleItems}
                role={{
                  assistant: {
                    placement: 'start',
                    typing: true,
                  },
                  user: {
                    placement: 'end',
                  },
                }}
              />
            ) : (
              <Flex vertical gap={18}>
                <Welcome
                  variant="borderless"
                  title="你好，我是 Supabase ERP 助手"
                  description="可以帮你梳理业务流程、生成检查清单，也可以在配置大模型接口后回答更具体的经营和系统问题。"
                />
                <Prompts
                  title="试试这些问题"
                  items={quickPrompts}
                  vertical={true}
                  onItemClick={(info: { data: { description?: unknown } }) =>
                    submitMessage(String(info.data.description || ''))
                  }
                />
              </Flex>
            )}
          </div>

          <div className="ai-chat-footer">
            <Space className="ai-chat-footer-tools">
              <Select
                size="small"
                value={activeProvider.id}
                className="ai-chat-provider-select"
                options={providers.map((item) => ({
                  label: `${item.name}${item.model ? ` / ${item.model}` : ''}`,
                  value: item.id,
                }))}
                onChange={setActiveProviderId}
              />
              <Space size={4}>
                {messages.length > 0 && (
                  <Button
                    type="text"
                    size="small"
                    onClick={() => {
                      setMessages([]);
                      setPendingCreate(null);
                    }}
                  >
                    清空
                  </Button>
                )}
                <Button
                  type="text"
                  size="small"
                  icon={<SettingOutlined />}
                  onClick={() => setConfigOpen(true)}
                />
              </Space>
            </Space>
            <Sender
              value={inputValue}
              loading={loading}
              className='ai-chat-sender'
              onChange={setInputValue}
              onSubmit={() => submitMessage(inputValue)}
              placeholder={`使用 ${activeProvider.name} 提问`}
            />
          </div>
        </Flex>
      </XProvider>

      <Modal
        title="大模型配置"
        open={configOpen}
        onCancel={() => setConfigOpen(false)}
        footer={null}
        width={620}
      >
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            DeepSeek/OpenAI 兼容接口请选择通用代理，接口地址填写 chat completions 地址；Ollama 选择 Ollama，接口地址填写 http://localhost:11434/api/chat。
          </Typography.Text>
          {providers.map((provider) => (
            <div className="ai-provider-card" key={provider.id}>
              <Space className="ai-provider-card-header">
                <Input
                  value={provider.name}
                  onChange={(event) => updateProvider(provider.id, { name: event.target.value })}
                  placeholder="显示名称，如 Ollama 本地"
                />
                <Button
                  danger
                  type="text"
                  icon={<DeleteOutlined />}
                  onClick={() => deleteProvider(provider.id)}
                />
              </Space>
              <Select
                value={provider.apiType}
                options={providerTypeOptions}
                onChange={(apiType) => updateProvider(provider.id, { apiType })}
              />
              <Input
                value={provider.endpoint}
                onChange={(event) => updateProvider(provider.id, { endpoint: event.target.value })}
                placeholder="接口地址，如 http://localhost:11434/api/chat"
              />
              <Input
                value={provider.model}
                onChange={(event) => updateProvider(provider.id, { model: event.target.value })}
                placeholder="模型 ID，如 qwen2.5、llama3.1、deepseek-r1"
              />
              <Input.Password
                value={provider.apiKey}
                onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
                placeholder="可选 API Key，Ollama 本地通常不用填"
              />
            </div>
          ))}
          <Button icon={<PlusOutlined />} onClick={addProvider} type="primary">
            新增大模型
          </Button>
        </Flex>
      </Modal>
    </Drawer>
  );
}
