import { useEffect, useMemo, useRef, useState } from "react";
import {
  BulbOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { Bubble, Prompts, Sender, Welcome, XProvider } from "@ant-design/x";
import {
  Button,
  Card,
  Drawer,
  Flex,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Typography,
  message,
} from "antd";
import type { BubbleListRef } from "@ant-design/x/es/bubble";
import { buildERPAnalysisContext } from "../utils/aiAnalysisTools";
import {
  handleCreateSkill,
  type CreateFlowState,
} from "../utils/aiCreateTools";
import { handleBusinessActionSkill } from "../utils/aiBusinessActionTools";
import { handleCreateBaqSkill } from "../utils/aiBaqTools";
import { useAuth } from "../contexts/AuthContext";
import {
  createId,
  createProvider,
  defaultAISettings,
  fetchAISettings,
  normalizeAISettings,
  providerTypeOptions,
  saveAISettings,
  type AIProviderConfig,
  type AISettingsConfig,
} from "../utils/aiConfig";
import "./AIChatDrawer.css";
import chatIcon from "../assets/fmt.webp";

interface AIChatDrawerProps {
  open: boolean;
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "loading" | "success" | "error";
}
type AiSkill = "auto" | "analysis" | "create" | "action" | "baq" | "chat";
const quickPrompts = [
  {
    key: "erp",
    icon: <DatabaseOutlined />,
    label: "ERP 数据助手",
    description: "帮我分析当前 ERP 业务数据应该从哪里入手",
  },
  {
    key: "finance",
    icon: <BulbOutlined />,
    label: "财务建议",
    description: "帮我整理一份本月应收应付检查清单",
  },
  {
    key: "inventory",
    icon: <SendOutlined />,
    label: "库存排查",
    description: "如何排查库存数量和采购入库不一致",
  },
  {
    key: "business",
    icon: <SendOutlined />,
    label: "新增业务",
    description: "帮我新增一个销售订单、采购订单、客户、供应商、物料等",
  },
];

const createRequestBody = (prompt: string, provider: AIProviderConfig) => {
  return {
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };
};

const stringifyReply = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value == null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(stringifyReply).filter(Boolean).join("\n");
  }

  if (typeof value === "object") {
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
  const choices = Array.isArray(record.choices)
    ? (record.choices as Record<string, unknown>[])
    : [];
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
      "",
      `你刚才问的是：“${prompt}”`,
      "",
      "点击底部齿轮可以新增或编辑多个大模型配置。Ollama 可直接使用 http://localhost:11434/api/chat。",
    ].join("\n");
  }

  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey
        ? { Authorization: `Bearer ${provider.apiKey}` }
        : {}),
    },
    body: JSON.stringify(createRequestBody(prompt, provider)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `AI 服务请求失败：${response.status}${errorText ? `，${errorText}` : ""}`,
    );
  }

  const data = (await response.json()) as unknown;
  return getReplyContent(data) || "AI 服务未返回文本内容。";
}

export function AIChatDrawer({ open, onClose }: AIChatDrawerProps) {
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingCreate, setPendingCreate] = useState<CreateFlowState | null>(
    null,
  );
  const [selectedSkill, setSelectedSkill] = useState<AiSkill>("auto");
  const [configOpen, setConfigOpen] = useState(false);
  const [aiSettings, setAISettings] =
    useState<AISettingsConfig>(defaultAISettings);
  const [configLoaded, setConfigLoaded] = useState(false);
  const listRef = useRef<BubbleListRef>(null);
  const saveTimerRef = useRef<number | null>(null);
  const { user } = useAuth();
  const providers = aiSettings.providers;
  const activeProviderId = aiSettings.activeProviderId;

  const activeProvider = useMemo(
    () =>
      providers.find((item) => item.id === activeProviderId) ||
      providers[0] ||
      defaultAISettings.providers[0],
    [activeProviderId, providers],
  );

  const bubbleItems = useMemo(
    () =>
      messages.map((item) => ({
        key: item.id,
        role: item.role,
        content: item.content,
        loading: item.status === "loading",
      })),
    [messages],
  );

  useEffect(() => {
    if (!open || configLoaded) {
      return;
    }

    fetchAISettings()
      .then((settings) => {
        setAISettings(settings);
        setConfigLoaded(true);
      })
      .catch(() => {
        setConfigLoaded(true);
        message.error("读取AI设置失败，将使用默认配置");
      });
  }, [configLoaded, open]);

  useEffect(() => {
    if (!configLoaded) {
      return;
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = window.setTimeout(() => {
      saveAISettings(normalizeAISettings(aiSettings)).catch(() => {
        console.log("保存AI设置失败");
      });
    }, 600);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [aiSettings, configLoaded]);

  const updateProvider = (id: string, patch: Partial<AIProviderConfig>) => {
    setAISettings((prev) => ({
      ...prev,
      providers: prev.providers.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  };

  const addProvider = () => {
    const next = createProvider();
    setAISettings((prev) => ({
      ...prev,
      providers: [...prev.providers, next],
      activeProviderId: next.id,
    }));
  };

  const deleteProvider = (id: string) => {
    setAISettings((prev) => {
      const next = prev.providers.filter((item) => item.id !== id);
      const safeNext = next.length ? next : defaultAISettings.providers;
      return {
        ...prev,
        providers: safeNext,
        activeProviderId:
          id === prev.activeProviderId ? safeNext[0].id : prev.activeProviderId,
      };
    });
  };

  const submitMessage = async (value: string) => {
    const prompt = value.trim();
    if (!prompt || loading) {
      return;
    }

    if (!aiSettings.enabled) {
      message.warning("AI助手已在系统设置中停用");
      return;
    }

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: prompt,
      status: "success",
    };
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      status: "loading",
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInputValue("");
    setLoading(true);
    window.setTimeout(() => listRef.current?.scrollTo({ top: "bottom" }), 0);

    try {
      const runResult = async () => {
        if (selectedSkill === "baq") {
          return handleCreateBaqSkill(prompt, activeProvider);
        }
        if (selectedSkill === "action") {
          return handleBusinessActionSkill(prompt, {
            id: user?.profile.id,
            username: user?.profile.username,
          });
        }
        if (selectedSkill === "create") {
          return handleCreateSkill(prompt, pendingCreate);
        }
        if (selectedSkill === "analysis") {
          const context = await buildERPAnalysisContext(prompt);
          return { status: "success", reply: await requestAIReply(context.prompt, activeProvider) };
        }
        if (selectedSkill === "chat") {
          return { status: "success", reply: await requestAIReply(prompt, activeProvider) };
        }
        const baqResult = await handleCreateBaqSkill(prompt, activeProvider);
        if (baqResult.status !== "ignored") return baqResult;
        const businessActionResult = await handleBusinessActionSkill(prompt, {
          id: user?.profile.id,
          username: user?.profile.username,
        });
        if (businessActionResult.status !== "ignored") return businessActionResult;
        return handleCreateSkill(prompt, pendingCreate);
      };
      const skillResult = await runResult();
      if (skillResult.status !== "ignored") {
        if ("pending" in skillResult) {
          setPendingCreate(skillResult.pending || null);
        }
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantMessage.id
              ? {
                  ...item,
                  content: skillResult.reply || "已处理所选技能。",
                  status: skillResult.status === "error" || skillResult.status === "invalid" ? "error" : "success",
                }
              : item,
          ),
        );
        return;
      }

      const analysisContext = await buildERPAnalysisContext(prompt);
      if (analysisContext.domains.length) {
        message.info(
          "已读取 ERP " + analysisContext.domains.join(" / ") + " 数据摘要",
        );
      }
      const reply = await requestAIReply(
        analysisContext.prompt,
        activeProvider,
      );
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantMessage.id
            ? { ...item, content: stringifyReply(reply), status: "success" }
            : item,
        ),
      );
    } catch (error) {
      const errorText =
        error instanceof Error ? error.message : "AI 服务暂时不可用。";
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantMessage.id
            ? { ...item, content: errorText, status: "error" }
            : item,
        ),
      );
      message.error(errorText);
    } finally {
      setLoading(false);
      window.setTimeout(() => listRef.current?.scrollTo({ top: "bottom" }), 0);
    }
  };

  return (
    <Drawer
      width={600}
      open={open}
      onClose={onClose}
      title="AI 智能对话"
      className="ai-chat-drawer"
      destroyOnClose={false}
    >
      <XProvider>
        <Flex vertical className="ai-chat-panel">
          <Card className="ai-chat-messages" variant="borderless">
            {messages.length > 0 ? (
              <Bubble.List
                ref={listRef}
                items={bubbleItems}
                role={{
                  assistant: {
                    placement: "start",
                    typing: true,
                  },
                  user: {
                    placement: "end",
                  },
                }}
              />
            ) : (
              <Flex vertical gap={18}>
                <Welcome
                  icon={<img src={chatIcon} alt="Chat Icon" />}
                  variant="borderless"
                  title="你好，我是 OPERP 助手"
                  description="可以帮你梳理业务流程、生成检查清单，也可以在配置大模型接口后回答更具体的经营和系统问题。"
                />
                <Prompts
                  title="试试这些问题"
                  items={quickPrompts}
                  vertical={true}
                  onItemClick={(info: { data: { description?: unknown } }) =>
                    submitMessage(String(info.data.description || ""))
                  }
                />
              </Flex>
            )}
          </Card>

          <Card
            title={false}
            className="ai-chat-footer"
            variant="borderless"
            size="small"
            extra={
              <Flex justify="space-between" align="center" className="ai-chat-footer-controls">
                <Select
                  size="small"
                  value={activeProvider.id}
                  className="ai-chat-provider-select"
                  options={providers.map((item) => ({
                    label: `${item.name}${item.model ? ` / ${item.model}` : ""}`,
                    value: item.id,
                  }))}
                  onChange={(activeProviderId) =>
                    setAISettings((prev) => ({ ...prev, activeProviderId }))
                  }
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
              </Flex>
            }
          >
            <Sender
              value={inputValue}
              loading={loading}
              className="ai-chat-sender"
              onChange={setInputValue}
              onSubmit={() => submitMessage(inputValue)}
              placeholder={`使用 ${activeProvider.name} 提问`}
            />
            <Radio.Group
              value={selectedSkill}
              className="ai-chat-skill-select"
              onChange={(event) => setSelectedSkill(event.target.value)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="auto">
                <span className="ai-skill-option">
                  <SendOutlined />
                  <span>自动</span>
                </span>
              </Radio.Button>
              <Radio.Button value="analysis">
                <span className="ai-skill-option">
                  <DatabaseOutlined />
                  <span>数据分析</span>
                </span>
              </Radio.Button>
              <Radio.Button value="create">
                <span className="ai-skill-option">
                  <PlusOutlined />
                  <span>创建业务</span>
                </span>
              </Radio.Button>
              <Radio.Button value="action">
                <span className="ai-skill-option">
                  <SendOutlined />
                  <span>业务动作</span>
                </span>
              </Radio.Button>
              <Radio.Button value="baq">
                <span className="ai-skill-option">
                  <DatabaseOutlined />
                  <span>创建 BAQ</span>
                </span>
              </Radio.Button>
              <Radio.Button value="chat">
                <span className="ai-skill-option">
                  <BulbOutlined />
                  <span>普通对话</span>
                </span>
              </Radio.Button>
            </Radio.Group>
          </Card>
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
            DeepSeek/OpenAI 兼容接口请选择通用代理，接口地址填写 chat
            completions 地址；Ollama 选择 Ollama，接口地址填写
            http://localhost:11434/api/chat。
          </Typography.Text>
          {providers.map((provider) => (
            <Card className="ai-provider-card" key={provider.id} size="small">
              <Space vertical style={{ width: '100%' }}>
                <Space className="ai-provider-card-header">
                  <Input
                    value={provider.name}
                    onChange={(event) =>
                      updateProvider(provider.id, { name: event.target.value })
                    }
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
                  onChange={(apiType) =>
                    updateProvider(provider.id, { apiType })
                  }
                />
                <Input
                  value={provider.endpoint}
                  onChange={(event) =>
                    updateProvider(provider.id, {
                      endpoint: event.target.value,
                    })
                  }
                  placeholder="接口地址，如 http://localhost:11434/api/chat"
                />
                <Input
                  value={provider.model}
                  onChange={(event) =>
                    updateProvider(provider.id, { model: event.target.value })
                  }
                  placeholder="模型 ID，如 qwen2.5、llama3.1、deepseek-r1"
                />
                <Input.Password
                  value={provider.apiKey}
                  onChange={(event) =>
                    updateProvider(provider.id, { apiKey: event.target.value })
                  }                  
                  placeholder="可选 API Key，Ollama 本地通常不用填"
                />
              </Space>
            </Card>
          ))}
          <Button icon={<PlusOutlined />} onClick={addProvider} type="primary">
            新增大模型
          </Button>
        </Flex>
      </Modal>
    </Drawer>
  );
}
