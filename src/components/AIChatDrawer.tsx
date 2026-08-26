import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  BulbOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  LinkOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  Bubble,
  Prompts,
  Sender,
  ThoughtChain,
  Welcome,
  XProvider,
} from "@ant-design/x";
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
import type { ThoughtChainItemType } from "@ant-design/x/es/thought-chain";
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
  trace?: ThoughtChainItemType[];
}
type AiSkill = "auto" | "analysis" | "create" | "action" | "baq" | "chat";
type AiChatStreamEvent =
  | { type: "step"; step: string; message: string; data?: unknown }
  | {
      type: "final";
      status?: "success" | "error" | "need_confirmation" | "needs_more";
      reply?: string;
      focus?: unknown;
      need_confirmation?: boolean;
      next_questions?: string[];
      data?: unknown;
    };
type AiChatStreamErrorEvent = {
  type: "error";
  ok?: false;
  error?: string;
};
type AiChatStreamPacket = AiChatStreamEvent | AiChatStreamErrorEvent;
const AI_SERVER_URL =
  import.meta.env.VITE_AI_SERVER_URL || "http://localhost:3001";
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

const readSessionId = () => {
  try {
    const key = "operp-ai-chat-session-id";
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const next = createId();
    localStorage.setItem(key, next);
    return next;
  } catch {
    return createId();
  }
};

const renderInlineMarkdown = (text: string) => {
  const parts: ReactNode[] = [];
  let index = 0;
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\))/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > index) {
      parts.push(text.slice(index, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(
        <code key={`${match.index}-code`} className="ai-markdown-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      parts.push(
        <strong key={`${match.index}-strong`}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*") || token.startsWith("_")) {
      parts.push(
        <em key={`${match.index}-em`}>
          {token.slice(1, -1)}
        </em>,
      );
    } else if (token.startsWith("![")) {
      const parsed = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (parsed) {
        parts.push(
          <img
            key={`${match.index}-img`}
            className="ai-markdown-image"
            src={parsed[2]}
            alt={parsed[1]}
          />,
        );
      } else {
        parts.push(token);
      }
    } else if (token.startsWith("[")) {
      const parsed = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (parsed) {
        parts.push(
          <a
            key={`${match.index}-link`}
            href={parsed[2]}
            target="_blank"
            rel="noreferrer"
            className="ai-markdown-link"
          >
            <LinkOutlined />
            <span>{parsed[1]}</span>
          </a>,
        );
      } else {
        parts.push(token);
      }
    }
    index = match.index + token.length;
  }

  if (index < text.length) {
    parts.push(text.slice(index));
  }

  return parts;
};

const renderMarkdown = (value: string) => {
  const normalized = value.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const nodes: ReactNode[] = [];

  blocks.forEach((block, blockIndex) => {
    const trimmed = block.trim();
    if (!trimmed) {
      return;
    }

    const codeMatch = trimmed.match(/^```(?:([^\n`]+))?\n([\s\S]*?)```$/);
    if (codeMatch) {
      nodes.push(
        <pre key={`block-${blockIndex}`} className="ai-markdown-codeblock">
          <code>{codeMatch[2].replace(/^\n+|\n+$/g, "")}</code>
        </pre>,
      );
      return;
    }

    const lines = trimmed.split("\n");
    if (lines.every((line) => /^[-*+]\s+/.test(line))) {
      nodes.push(
        <ul key={`block-${blockIndex}`} className="ai-markdown-list">
          {lines.map((line, lineIndex) => (
            <li key={`${blockIndex}-${lineIndex}`}>{renderInlineMarkdown(line.replace(/^[-*+]\s+/, ""))}</li>
          ))}
        </ul>,
      );
      return;
    }

    if (lines.every((line) => /^\d+\.\s+/.test(line))) {
      nodes.push(
        <ol key={`block-${blockIndex}`} className="ai-markdown-list">
          {lines.map((line, lineIndex) => (
            <li key={`${blockIndex}-${lineIndex}`}>{renderInlineMarkdown(line.replace(/^\d+\.\s+/, ""))}</li>
          ))}
        </ol>,
      );
      return;
    }

    if (/^>\s?/.test(lines[0])) {
      nodes.push(
        <blockquote key={`block-${blockIndex}`} className="ai-markdown-quote">
          {renderInlineMarkdown(lines.map((line) => line.replace(/^>\s?/, "")).join("\n"))}
        </blockquote>,
      );
      return;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      nodes.push(
        <Tag key={`block-${blockIndex}`} className={`ai-markdown-h${level}`}>
          {renderInlineMarkdown(heading[2])}
        </Tag>,
      );
      return;
    }

    nodes.push(
      <p key={`block-${blockIndex}`} className="ai-markdown-paragraph">
        {renderInlineMarkdown(trimmed)}
      </p>,
    );
  });

  return nodes.length ? nodes : value;
};

const MarkdownMessage = ({ content }: { content: string }) => (
  <div className="ai-markdown-body">{renderMarkdown(content)}</div>
);

const renderThoughtTitle = (message: string) => {
  const value = message.trim();
  if (!value) return "处理中";
  if (value.includes("加载上下文")) return "加载上下文";
  if (value.includes("识别意图")) return "识别意图";
  if (value.includes("拆解任务")) return "任务拆解";
  if (value.includes("执行工具")) return "工具调用";
  if (value.includes("写入会话")) return "记忆写入";
  if (value.includes("整理回复")) return "整理回复";
  return value;
};

const AssistantMessage = ({
  message: chatMessage,
}: {
  message: ChatMessage;
}) => (
  <div className="ai-assistant-block">
    {chatMessage.trace?.length ? (
      <ThoughtChain
        className="ai-thought-chain"
        items={chatMessage.trace}
        line="solid"
        defaultExpandedKeys={chatMessage.trace.map((item) => item.key).filter(Boolean) as string[]}
      />
    ) : null}
    {chatMessage.content ? <MarkdownMessage content={chatMessage.content} /> : null}
  </div>
);

const streamAIReply = async (
  payload: Record<string, unknown>,
  onEvent: (event: AiChatStreamPacket) => void | Promise<void>,
) => {
  const response = await fetch(`${AI_SERVER_URL}/api/ai/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ ...payload, stream: true }),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(
      `AI 服务请求失败：${response.status}${errorText ? `，${errorText}` : ""}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const flush = async () => {
    if (!eventName || !dataLines.length) return;
    const raw = dataLines.join("\n");
    try {
      await onEvent(JSON.parse(raw) as AiChatStreamPacket);
    } catch {
      // ignore malformed event payloads
    }
    eventName = "";
    dataLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line) {
        await flush();
        continue;
      }
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
  }

  await flush();
};

export function AIChatDrawer({ open, onClose }: AIChatDrawerProps) {
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const sessionId = useMemo(() => readSessionId(), []);

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
        content:
          item.role === "assistant" ? (
            <AssistantMessage message={item} />
          ) : (
            item.content
          ),
        loading: false,
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
      trace: [],
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInputValue("");
    setLoading(true);
    window.setTimeout(() => listRef.current?.scrollTo({ top: "bottom" }), 0);

    try {
      const payload = {
        session_id: sessionId,
        user_id: user?.profile.id,
        text: prompt,
        skill: selectedSkill,
        context: {
          page: window.location.pathname,
          current_focus: null,
          recent_messages: messages.slice(-12).map((item) => ({
            role: item.role,
            content: item.content,
            status: item.status,
          })),
        },
        provider: {
          id: activeProvider.id,
          name: activeProvider.name,
          endpoint: activeProvider.endpoint,
          model: activeProvider.model,
          apiType: activeProvider.apiType,
          apiKey: activeProvider.apiKey,
        },
      } as const;

      let traceItems: ThoughtChainItemType[] = [];
      const updateAssistant = (patch: Partial<ChatMessage>) => {
        setMessages((prev) =>
          prev.map((item) => (item.id === assistantMessage.id ? { ...item, ...patch } : item)),
        );
      };

      await streamAIReply(payload, async (event) => {
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));

        if (event.type === "step") {
          const key = `${event.step}-${traceItems.length}`;
          traceItems = [
            ...traceItems,
            {
              key,
              title: renderThoughtTitle(event.step || event.message),
              description: event.message,
              status: "loading",
              blink: true,
            },
          ];
          updateAssistant({
            trace: traceItems,
            content: "",
            status: "loading",
          });
          return;
        }

        if (event.type === "error") {
          updateAssistant({
            trace: traceItems,
            content: event.error || "AI 服务暂时不可用。",
            status: "error",
          });
          return;
        }

        traceItems = traceItems.map((item, index) =>
          index === traceItems.length - 1
            ? { ...item, status: event.status === "error" ? "error" : "success", blink: false }
            : { ...item, status: "success", blink: false },
        );
        updateAssistant({
          trace: traceItems,
          content: "",
          status: event.status === "error" ? "error" : "success",
        });
        updateAssistant({
          trace: traceItems,
          content: event.reply || "已处理所选技能。",
          status: event.status === "error" ? "error" : "success",
        });
        if (event.next_questions?.length) {
          message.info(event.next_questions[0]);
        }
      });
    } catch (error) {
      const errorText =
        error instanceof Error ? error.message : typeof error === "string" ? error : "AI 服务暂时不可用。";
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
                    typing: false,
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
