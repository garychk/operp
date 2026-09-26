import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from 'react-i18next';
import type { CSSProperties, ReactNode } from "react";
import {
  BulbOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  MoreOutlined,
  LinkOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  Bubble,
  Conversations,
  Prompts,
  Sender,
  Think,
  Welcome,
  XProvider,
} from "@ant-design/x";
import {
  Button,
  Card,
  Drawer,
  Dropdown,
  Flex,
  Input,
  Modal,
  Select,
  Space,
  Typography,
  message,
} from "antd";
import type { ThoughtChainItemType } from "@ant-design/x/es/thought-chain";
import { useNavigate } from "react-router-dom";
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
import {
  createChatSession,
  deleteChatSession,
  fetchChatMessages,
  fetchChatSessions,
  saveChatMessage,
  summarizeMessagePreview,
  updateChatSession,
  type AIChatSessionRecord,
} from "../utils/aiChatSessions";
import "./AIChatPanel.css";
import chatIcon from "../assets/fmt.webp";

export interface AIChatPanelProps {
  /** 面板是否可见/激活。false 时不加载配置与会话，避免无用请求。 */
  active?: boolean;
  /** drawer：嵌在抽屉里，宽度受限；page：作为整页使用，空间更宽。 */
  variant?: "drawer" | "page";
  /** 站内跳转后的回调（抽屉用它来关闭自己）。 */
  onNavigate?: () => void;
  className?: string;
  style?: CSSProperties;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "loading" | "success" | "error";
  trace?: ThoughtChainItemType[];
  focus?: unknown;
  route?: string;
  routeLabel?: string;
  sources?: Array<{
    title?: string;
    category?: string | null;
    sourceType?: string | null;
    sourceRef?: string | null;
    docId?: number;
    chunkId?: number;
    similarity?: number;
  }>;
}

interface ConversationListItem {
  id: string;
  title: string;
  lastMessage: string;
  updatedAt: string;
}
type AiSkill = "auto" | "analysis" | "create" | "action" | "baq" | "chat";
type AiChatStreamEvent =
  | { type: "step"; step: string; message: string; data?: unknown }
  | {
      type: "final";
      status?: "success" | "error" | "need_confirmation" | "needs_more";
      reply?: string;
      focus?: unknown;
      route?: string;
      routeLabel?: string;
      sources?: Array<{
        title?: string;
        category?: string | null;
        sourceType?: string | null;
        sourceRef?: string | null;
        docId?: number;
        chunkId?: number;
        similarity?: number;
      }>;
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
const resolveAIBaseUrl = () => {
  const explicitUrl = import.meta.env.VITE_AI_SERVER_URL;
  if (explicitUrl) {
    return explicitUrl.replace(/\/$/, "");
  }

  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return "http://localhost:3001/api/ai";
  }

  return "/api/ai";
};

const AI_SERVER_URL = resolveAIBaseUrl();
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
        <strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>,
      );
    } else if (token.startsWith("*") || token.startsWith("_")) {
      parts.push(<em key={`${match.index}-em`}>{token.slice(1, -1)}</em>);
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

type TableAlign = "left" | "center" | "right";

const TABLE_NUMERIC_CELL = /^-?[\d,]+(?:\.\d+)?%?$/;
const TABLE_DIVIDER_CELL = /^:?-{2,}:?$/;
const TABLE_TOTAL_LABEL = /^(?:合计|总计|小计|共计|total)$/i;
const TABLE_IDENTIFIER_HEADER =
  /(?:编码|编号|单号|料号|序号|代码|凭证|批次|id|code|no\.?|sn|规格|名称|单位|日期)/i;
const tableNumberFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 4,
});

const isTableRow = (line: string) => /^\s*\|/.test(line);

const splitTableRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const isTableDivider = (line: string) => {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => TABLE_DIVIDER_CELL.test(cell));
};

const parseTableAlign = (line: string): TableAlign[] =>
  splitTableRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });

const isNumericCell = (text: string) => TABLE_NUMERIC_CELL.test(text.trim());

const isZeroCell = (text: string) => /^0+(?:\.0+)?$/.test(text.replace(/,/g, "").trim());

const formatNumericCell = (text: string) => {
  const value = Number(text.replace(/,/g, "").trim());
  return Number.isFinite(value) ? tableNumberFormatter.format(value) : text;
};

const MarkdownTable = ({ lines }: { lines: string[] }) => {
  const columns = splitTableRow(lines[0]).length;
  const hasDivider = lines.length > 1 && isTableDivider(lines[1]);
  const bodyLines = hasDivider ? lines.slice(2) : lines.slice(1);
  const explicitAligns = hasDivider ? parseTableAlign(lines[1]) : [];

  const rows = bodyLines
    .filter((line) => line.trim() && !isTableDivider(line))
    .map((line) => {
      const cells = splitTableRow(line);
      return Array.from({ length: columns }, (_, index) => cells[index] ?? "");
    });

  const headerCells = Array.from(
    { length: columns },
    (_, index) => splitTableRow(lines[0])[index] ?? "",
  );

  const numericColumns = headerCells.map((header, columnIndex) => {
    if (TABLE_IDENTIFIER_HEADER.test(header)) return false;
    const values = rows.map((cells) => cells[columnIndex]).filter(Boolean);
    return values.length > 0 && values.every(isNumericCell);
  });

  const resolveAlign = (columnIndex: number): TableAlign => {
    const explicit = explicitAligns[columnIndex];
    if (explicit === "center" || explicit === "right") return explicit;
    return numericColumns[columnIndex] ? "right" : "left";
  };

  const renderHeader = (header: string) => renderInlineMarkdown(header);

  const renderCell = (cell: string, columnIndex: number) => {
    if (!cell) {
      return <span className="ai-markdown-table-empty">—</span>;
    }
    if (!numericColumns[columnIndex] || !isNumericCell(cell)) {
      return renderInlineMarkdown(cell);
    }
    return (
      <span
        className={
          isZeroCell(cell)
            ? "ai-markdown-table-num ai-markdown-table-zero"
            : "ai-markdown-table-num"
        }
      >
        {formatNumericCell(cell)}
      </span>
    );
  };

  return (
    <div className="ai-markdown-table-wrap">
      <table className="ai-markdown-table">
        <thead>
          <tr>
            {headerCells.map((header, columnIndex) => (
              <th key={`head-${columnIndex}`} style={{ textAlign: resolveAlign(columnIndex) }}>
                {renderHeader(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr
              key={`row-${rowIndex}`}
              className={TABLE_TOTAL_LABEL.test(cells[0]) ? "ai-markdown-table-total" : undefined}
            >
              {cells.map((cell, columnIndex) => (
                <td
                  key={`cell-${rowIndex}-${columnIndex}`}
                  style={{ textAlign: resolveAlign(columnIndex) }}
                >
                  {renderCell(cell, columnIndex)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

    if (isTableRow(lines[0]) && splitTableRow(lines[0]).length > 1) {
      const firstNonTable = lines.findIndex((line, index) => index > 0 && !isTableRow(line));
      const tableLines = firstNonTable === -1 ? lines : lines.slice(0, firstNonTable);
      nodes.push(<MarkdownTable key={`block-${blockIndex}`} lines={tableLines} />);

      const restLines = firstNonTable === -1 ? [] : lines.slice(firstNonTable);
      const rest = restLines.join("\n").trim();
      if (rest) {
        nodes.push(
          <p key={`block-${blockIndex}-rest`} className="ai-markdown-paragraph">
            {renderInlineMarkdown(rest)}
          </p>,
        );
      }
      return;
    }

    if (lines.every((line) => /^[-*+]\s+/.test(line))) {
      nodes.push(
        <ul key={`block-${blockIndex}`} className="ai-markdown-list">
          {lines.map((line, lineIndex) => (
            <li key={`${blockIndex}-${lineIndex}`}>
              {renderInlineMarkdown(line.replace(/^[-*+]\s+/, ""))}
            </li>
          ))}
        </ul>,
      );
      return;
    }

    if (lines.every((line) => /^\d+\.\s+/.test(line))) {
      nodes.push(
        <ol key={`block-${blockIndex}`} className="ai-markdown-list">
          {lines.map((line, lineIndex) => (
            <li key={`${blockIndex}-${lineIndex}`}>
              {renderInlineMarkdown(line.replace(/^\d+\.\s+/, ""))}
            </li>
          ))}
        </ol>,
      );
      return;
    }

    if (/^>\s?/.test(lines[0])) {
      nodes.push(
        <blockquote key={`block-${blockIndex}`} className="ai-markdown-quote">
          {renderInlineMarkdown(
            lines.map((line) => line.replace(/^>\s?/, "")).join("\n"),
          )}
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

const renderThoughtTitle = (
  message: string,
  t: (key: string, options?: Record<string, unknown>) => string,
) => {
  const value = message.trim();
  if (!value) return t("aiChat.thought.processing");
  const nodeLabels: Record<string, string> = {
    contextLoader: t("aiChat.thought.loadContext"),
    intentRouter: t("aiChat.thought.identifyIntent"),
    planner: t("aiChat.thought.planning"),
    toolExecutor: t("aiChat.thought.execute"),
    memoryWriter: t("aiChat.thought.saveMemory"),
    responseComposer: t("aiChat.thought.compose"),
  };
  if (nodeLabels[value]) return nodeLabels[value];
  if (value.includes("加载上下文")) return t("aiChat.thought.loadingContext");
  if (value.includes("识别意图")) return t("aiChat.thought.detectIntent");
  if (value.includes("拆解任务")) return t("aiChat.thought.decompose");
  if (value.includes("执行工具")) return t("aiChat.thought.invokeTool");
  if (value.includes("写入会话")) return t("aiChat.thought.writeMemory");
  if (value.includes("整理回复")) return t("aiChat.thought.composeReply");
  return value;
};

const resolveThinkTitle = (
  trace: ThoughtChainItemType[],
  t: (key: string, options?: Record<string, unknown>) => string,
) => {
  const pending = trace.find((step) => step.status === "loading");
  if (pending) {
    return t("aiChat.think.runningStep", {
      step: pending.title || t("aiChat.think.running"),
    });
  }
  if (trace.some((step) => step.status === "error")) {
    return t("aiChat.think.failed");
  }
  return t("aiChat.think.done", { count: trace.length });
};

const formatStepContent = (data: unknown): string => {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  if (Array.isArray(data))
    return data
      .map((item) => formatStepContent(item))
      .filter(Boolean)
      .join("\n");
  if (typeof data === "object") {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
  return String(data);
};

const isPendingStep = (message: string) => message.startsWith("正在");

const formatStepResult = (
  data: unknown,
  message: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string => {
  const value =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};

  if (message.includes("上下文已加载")) {
    const recentMessages = Number(value.recentMessages || 0);
    if (recentMessages) {
      return t("aiChat.result.contextRecent", {
        count: recentMessages,
        focus: value.hasFocus ? t("aiChat.result.focusSuffix") : "",
      });
    }
    return t("aiChat.result.contextEmpty");
  }

  if (message.includes("意图已识别")) {
    const intentLabels: Record<string, string> = {
      baq: t("aiChat.result.intentBaQ"),
      create: t("aiChat.result.intentCreate"),
      update: t("aiChat.result.intentUpdate"),
      analysis: t("aiChat.result.intentAnalysis"),
      knowledge: t("aiChat.result.intentKnowledge"),
      chat: t("aiChat.result.intentChat"),
    };
    const intent = String(value.intent || "chat");
    const domain = value.domain
      ? t("aiChat.result.domainSuffix", { value: String(value.domain) })
      : "";
    const target = value.target
      ? t("aiChat.result.targetSuffix", { value: String(value.target) })
      : "";
    const queryMode = value.queryMode
      ? t("aiChat.result.queryModeSuffix", { value: String(value.queryMode) })
      : "";
    const responseMode = value.responseMode
      ? t("aiChat.result.responseModeSuffix", {
          value: String(value.responseMode),
        })
      : "";
    return t("aiChat.result.intentSummary", {
      intent: intentLabels[intent] || intent,
      domain,
      target,
      queryMode,
      responseMode,
    });
  }

  if (message.includes("任务已拆解")) {
    const plan = Array.isArray(value.plan) ? value.plan : [];
    if (!plan.length) return t("aiChat.result.noPlan");
    const first = plan[0] as Record<string, unknown>;
    const toolLabels: Record<string, string> = {
      "baq.upsert": t("aiChat.result.toolBaq"),
      "entity.upsert": t("aiChat.result.toolEntity"),
      "finance.summary": t("aiChat.result.toolFinance"),
      "chat.respond": t("aiChat.result.toolChat"),
    };
    return t("aiChat.result.planSummary", {
      count: plan.length,
      tool:
        toolLabels[String(first.tool)] ||
        String(first.tool || t("aiChat.result.toolDefault")),
    });
  }

  if (message.includes("工具执行完成")) {
    const results = Array.isArray(value.toolResults) ? value.toolResults : [];
    const result = results[0] as Record<string, unknown> | undefined;
    if (result?.reply) return String(result.reply);
    if (result?.status === "needs_more") return t("aiChat.result.needMore");
    if (result?.status === "error") return t("aiChat.result.toolError");
    return results.length ? t("aiChat.result.toolsDone") : t("aiChat.result.noTools");
  }

  if (message.includes("会话记忆已写入")) {
    return t("aiChat.result.memorySaved");
  }

  if (message.includes("回复已整理")) {
    return t("aiChat.result.replyReady");
  }

  return formatStepContent(data) || message;
};

const streamAIReply = async (
  payload: Record<string, unknown>,
  onEvent: (event: AiChatStreamPacket) => void | Promise<void>,
  t: (key: string, options?: Record<string, unknown>) => string,
) => {
  const response = await fetch(`${AI_SERVER_URL}/chat`, {
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
      t("aiChat.error.requestPrefix", {
        detail: [String(response.status), ...(errorText ? [errorText] : [])].join(" - "),
      }),
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

export function AIChatPanel({
  active = true,
  variant = "drawer",
  onNavigate,
  className,
  style,
}: AIChatPanelProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AiSkill>("auto");
  const [configOpen, setConfigOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedThinks, setExpandedThinks] = useState<Record<string, boolean>>({});
  const [aiSettings, setAISettings] =
    useState<AISettingsConfig>(defaultAISettings);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [conversationItems, setConversationItems] = useState<ConversationListItem[]>([]);
  const messageListRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<number | null>(null);
  const { user } = useAuth();
  const navigate = useNavigate();
  const providers = aiSettings.providers;
  const activeProviderId = aiSettings.activeProviderId;

  const aiSkillOptions: { value: AiSkill; label: string; icon: ReactNode }[] = [
    { value: "auto", label: t("aiChat.skill.auto"), icon: <SendOutlined /> },
    { value: "analysis", label: t("aiChat.skill.analysis"), icon: <DatabaseOutlined /> },
    { value: "create", label: t("aiChat.skill.create"), icon: <PlusOutlined /> },
    { value: "action", label: t("aiChat.skill.action"), icon: <SendOutlined /> },
    { value: "baq", label: t("aiChat.skill.baq"), icon: <DatabaseOutlined /> },
    { value: "chat", label: t("aiChat.skill.chat"), icon: <BulbOutlined /> },
  ];

  const quickPrompts = [
    {
      key: "erp",
      icon: <DatabaseOutlined />,
      label: t("aiChat.prompt.erp.label"),
      description: t("aiChat.prompt.erp.description"),
    },
    {
      key: "finance",
      icon: <BulbOutlined />,
      label: t("aiChat.prompt.finance.label"),
      description: t("aiChat.prompt.finance.description"),
    },
    {
      key: "inventory",
      icon: <SendOutlined />,
      label: t("aiChat.prompt.inventory.label"),
      description: t("aiChat.prompt.inventory.description"),
    },
    {
      key: "business",
      icon: <SendOutlined />,
      label: t("aiChat.prompt.business.label"),
      description: t("aiChat.prompt.business.description"),
    },
  ];

  const activeProvider = useMemo(
    () =>
      providers.find((item) => item.id === activeProviderId) ||
      providers[0] ||
      defaultAISettings.providers[0],
    [activeProviderId, providers],
  );
  const activeSkill =
    aiSkillOptions.find((skill) => skill.value === selectedSkill) ||
    aiSkillOptions[0];

  useEffect(() => {
    if (!active || configLoaded) {
      return;
    }

    fetchAISettings()
      .then((settings) => {
        setAISettings(settings);
        setConfigLoaded(true);
      })
      .catch(() => {
        setConfigLoaded(true);
        message.error(t("aiChat.msg.settingsLoadFailed"));
      });
  }, [configLoaded, active]);

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

  const syncSessionId = (sessionId: string) => {
    try {
      localStorage.setItem("operp-ai-chat-session-id", sessionId);
    } catch {
      // ignore local storage errors
    }
  };

  const formatConversationTime = (value?: string | null) => {
    if (!value) return t("aiChat.time.justNow");
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return t("aiChat.time.justNow");
    const diff = Date.now() - time;
    if (diff < 60_000) return t("aiChat.time.justNow");
    if (diff < 3_600_000)
      return t("aiChat.time.minutesAgo", {
        value: Math.max(1, Math.floor(diff / 60_000)),
      });
    if (diff < 86_400_000)
      return t("aiChat.time.hoursAgo", {
        value: Math.max(1, Math.floor(diff / 3_600_000)),
      });
    return t("aiChat.time.daysAgo", {
      value: Math.max(1, Math.floor(diff / 86_400_000)),
    });
  };

  const mapSessionToListItem = (session: AIChatSessionRecord): ConversationListItem => ({
    id: session.id,
    title:
      !session.title || session.title === "新对话"
        ? t("aiChat.newConversation")
        : session.title,
    lastMessage: session.last_message_preview || t("aiChat.noMessages"),
    updatedAt: formatConversationTime(session.last_message_at || session.updated_at),
  });

  const replaceConversationItem = (session: AIChatSessionRecord) => {
    setConversationItems((prev) => {
      const nextItem = mapSessionToListItem(session);
      const filtered = prev.filter((item) => item.id !== session.id);
      return [nextItem, ...filtered];
    });
  };

  const loadConversationMessages = async (conversationId: string) => {
    const rows = await fetchChatMessages(conversationId);
    setMessages(
      rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        status: row.status || "success",
        trace: row.trace_json || undefined,
        focus: row.focus_json || undefined,
        route: row.route || undefined,
        routeLabel: row.route_label || undefined,
        sources: Array.isArray((row as { sources_json?: unknown }).sources_json)
          ? ((row as { sources_json?: unknown[] }).sources_json as ChatMessage["sources"])
          : undefined,
      })),
    );
  };

  const ensureSession = async (preferredTitle?: string) => {
    if (activeConversationId) {
      return activeConversationId;
    }

    const sessionId = readSessionId();
    const session = await createChatSession({
      id: sessionId,
      user_id: user?.profile.id ?? null,
      title: preferredTitle?.trim() || t("aiChat.newConversation"),
    });
    syncSessionId(session.id);
    setActiveConversationId(session.id);
    replaceConversationItem(session);
    setMessages([]);
    return session.id;
  };

  useEffect(() => {
    if (!active || sessionsLoaded) {
      return;
    }

    const loadSessions = async () => {
      try {
        const sessions = await fetchChatSessions(user?.profile.id ?? null);
        const localSessionId = readSessionId();
        const items = sessions.map(mapSessionToListItem);
        setConversationItems(items);

        let activeId = sessions.find((session) => session.id === localSessionId)?.id || sessions[0]?.id || "";

        if (!activeId) {
          const created = await createChatSession({
            id: localSessionId,
            user_id: user?.profile.id ?? null,
            title: t("aiChat.newConversation"),
          });
          activeId = created.id;
          setConversationItems([mapSessionToListItem(created)]);
        }

        syncSessionId(activeId);
        setActiveConversationId(activeId);
        await loadConversationMessages(activeId);
      } catch (error) {
        console.error("加载 AI 对话历史失败", error);
        message.error(t("aiChat.msg.loadHistoryFailed"));
      } finally {
        setSessionsLoaded(true);
      }
    };

    void loadSessions();
  }, [active, sessionsLoaded, user?.profile.id]);

  useEffect(() => {
    if (!active) {
      return;
    }
    window.setTimeout(scrollMessagesToBottom, 0);
  }, [messages, active]);

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

  const scrollMessagesToBottom = () => {
    const container = messageListRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  };

  const handleCreateConversation = async () => {
    setHistoryOpen(false);
    try {
      const session = await createChatSession({
        id: createId(),
        user_id: user?.profile.id ?? null,
        title: t("aiChat.newConversation"),
      });
      syncSessionId(session.id);
      setActiveConversationId(session.id);
      setMessages([]);
      replaceConversationItem(session);
      message.success(t("aiChat.msg.conversationCreated"));
    } catch (error) {
      console.error("新建 AI 对话失败", error);
      message.error(t("aiChat.msg.createFailed"));
    }
  };

  const handleSelectConversation = async (conversationId: string) => {
    setHistoryOpen(false);
    setActiveConversationId(conversationId);
    syncSessionId(conversationId);
    try {
      await loadConversationMessages(conversationId);
    } catch (error) {
      console.error("读取 AI 对话消息失败", error);
      message.error(t("aiChat.msg.loadConversationFailed"));
    }
  };

  const handleDeleteConversation = async (conversationId: string) => {
    try {
      await deleteChatSession(conversationId);
      const nextItems = conversationItems.filter((item) => item.id !== conversationId);
      setConversationItems(nextItems);

      if (activeConversationId === conversationId) {
        const nextId = nextItems[0]?.id || "";
        setActiveConversationId(nextId);
        syncSessionId(nextId || createId());
        if (nextId) {
          await loadConversationMessages(nextId);
        } else {
          setMessages([]);
        }
      }

      message.success(t("aiChat.msg.deleted"));
    } catch (error) {
      console.error("删除 AI 对话失败", error);
      message.error(t("aiChat.msg.deleteFailed"));
    }
  };

  const submitMessage = async (value: string) => {
    const prompt = value.trim();
    if (!prompt || loading) {
      return;
    }

    if (!aiSettings.enabled) {
      message.warning(t("aiChat.msg.aiDisabled"));
      return;
    }

    // 多租户：没有租户上下文时 ai-server 会直接 403（fail-closed），
    // 与其让用户看到一个含糊的「请求失败」，不如在这里拦下来讲清楚。
    if (!user?.tenantId) {
      message.warning(t("aiChat.msg.noTenant"));
      return;
    }

    const conversationId = await ensureSession(t("aiChat.newConversation"));
    const currentConversation = conversationItems.find(
      (item) => item.id === conversationId,
    );
    const defaultTitle = t("aiChat.newConversation");
    const shouldRenameFromFirstMessage =
      (!currentConversation ||
        currentConversation.title === defaultTitle ||
        currentConversation.title === "新对话") &&
      messages.filter((item) => item.role === "user").length === 0;
    const nextConversationTitle = summarizeMessagePreview(prompt) || defaultTitle;

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
    window.setTimeout(scrollMessagesToBottom, 0);

    let traceItems: ThoughtChainItemType[] = [];
    try {
      await saveChatMessage({
        id: userMessage.id,
        session_id: conversationId,
        user_id: user?.profile.id ?? null,
        role: "user",
        content: userMessage.content,
        status: "success",
      });

      const sessionMeta = await updateChatSession(conversationId, {
        title: shouldRenameFromFirstMessage
          ? nextConversationTitle
          : undefined,
        last_message_preview: summarizeMessagePreview(prompt),
        last_message_at: new Date().toISOString(),
      });
      replaceConversationItem(sessionMeta);

      const payload = {
        session_id: conversationId,
        user_id: user?.profile.id,
        // ai-server 走 service_role，绕过 RLS，必须显式告诉它查哪个租户
        tenant_id: user?.tenantId ?? null,
        text: prompt,
        skill: selectedSkill,
        context: {
          page: window.location.pathname,
          current_focus:
            [...messages]
              .reverse()
              .find((item) => item.role === "assistant" && item.focus)?.focus ||
            null,
          recent_messages: messages.slice(-12).map((item) => ({
            role: item.role,
            content: item.content,
            status: item.status,
          })),
        },
        provider: {
          id: activeProvider.id,
          name: activeProvider.name,
        },
      } as const;

      const updateAssistant = (patch: Partial<ChatMessage>) => {
        setMessages((prev) =>
          prev.map((item) =>
            item.id === assistantMessage.id ? { ...item, ...patch } : item,
          ),
        );
      };

      await streamAIReply(payload, async (event) => {
        await new Promise((resolve) =>
          window.requestAnimationFrame(() => resolve(null)),
        );

        if (event.type === "step") {
          const existingIndex = traceItems.findIndex((item) =>
            String(item.key || "").startsWith(`${event.step}:`),
          );
          const key = `${event.step}:${existingIndex >= 0 ? existingIndex : traceItems.length}`;
          const nextItem: ThoughtChainItemType = {
            key,
            title: renderThoughtTitle(event.step || event.message, t),
            description: isPendingStep(event.message)
              ? event.message
              : undefined,
            content: isPendingStep(event.message)
              ? undefined
              : formatStepResult(event.data, event.message, t),
            status: isPendingStep(event.message) ? "loading" : "success",
            blink: isPendingStep(event.message),
          };
          if (existingIndex >= 0) {
            traceItems = traceItems.map((item, index) =>
              index === existingIndex ? nextItem : item,
            );
          } else {
            traceItems = [...traceItems, nextItem];
          }
          updateAssistant({
            trace: traceItems,
            content: "",
            status: "loading",
          });
          window.setTimeout(scrollMessagesToBottom, 0);
          return;
        }

        if (event.type === "error") {
          traceItems = traceItems.map((item) =>
            item.status === "loading"
              ? {
                  ...item,
                  status: "error",
                  blink: false,
                  description: t("aiChat.error.failed"),
                  content: event.error || t("aiChat.error.serverError"),
                }
              : item,
          );
          updateAssistant({
            trace: traceItems,
            content: event.error || t("aiChat.error.unavailable"),
            status: "error",
            sources: [],
          });
          await saveChatMessage({
            id: assistantMessage.id,
            session_id: conversationId,
            user_id: user?.profile.id ?? null,
            role: "assistant",
            content: event.error || t("aiChat.error.unavailable"),
            status: "error",
            trace_json: traceItems,
            sources_json: [],
          });
          window.setTimeout(scrollMessagesToBottom, 0);
          return;
        }

        traceItems = traceItems.map((item) =>
          item.status === "loading"
            ? {
                ...item,
                status: event.status === "error" ? "error" : "success",
                blink: false,
                content:
                  formatStepResult(event.data, "回复已整理", t) || item.content,
              }
            : { ...item, status: "success", blink: false },
        );
        updateAssistant({
          trace: traceItems,
          content: "",
          status: event.status === "error" ? "error" : "success",
        });
        updateAssistant({
          trace: traceItems,
          content: event.reply || t("aiChat.reply.handled"),
          focus: event.focus,
          route: event.route,
          routeLabel: event.routeLabel,
          sources: event.sources,
          status: event.status === "error" ? "error" : "success",
        });
        await saveChatMessage({
          id: assistantMessage.id,
          session_id: conversationId,
          user_id: user?.profile.id ?? null,
          role: "assistant",
          content: event.reply || t("aiChat.reply.handled"),
          status: event.status === "error" ? "error" : "success",
          trace_json: traceItems,
          focus_json: event.focus,
          sources_json: event.sources,
          route: event.route,
          route_label: event.routeLabel,
        });
        const updatedSession = await updateChatSession(conversationId, {
          last_message_preview: summarizeMessagePreview(event.reply || t("aiChat.reply.handled")),
          last_message_at: new Date().toISOString(),
        });
        replaceConversationItem(updatedSession);
        window.setTimeout(scrollMessagesToBottom, 0);
        if (event.next_questions?.length) {
          message.info(event.next_questions[0]);
        }
      }, t);
    } catch (error) {
      const errorText =
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : t("aiChat.error.unavailable");
      traceItems = traceItems.map((item) =>
        item.status === "loading"
          ? {
              ...item,
              status: "error",
              blink: false,
              description: t("aiChat.error.requestFailed"),
              content: errorText,
            }
          : item,
      );
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantMessage.id
            ? {
                ...item,
                trace: traceItems,
                content: errorText,
                status: "error",
              }
            : item,
        ),
      );
      await saveChatMessage({
        id: assistantMessage.id,
        session_id: conversationId,
        user_id: user?.profile.id ?? null,
        role: "assistant",
        content: errorText,
        status: "error",
        trace_json: traceItems,
        sources_json: [],
      }).catch((saveError) => {
        console.error("保存 AI 错误消息失败", saveError);
      });
      message.error(errorText);
    } finally {
      setLoading(false);
      window.setTimeout(scrollMessagesToBottom, 0);
    }
  };

  return (
    <>
      <XProvider>
        <Flex
          vertical
          className={`ai-chat-panel ai-chat-panel-${variant}${className ? ` ${className}` : ""}`}
          style={style}
        >
          <Card
            className="ai-chat-messages"
            variant="borderless"
            extra={
              <Space size={8}>
                <Button
                  icon={<ClockCircleOutlined />}
                  onClick={() => setHistoryOpen(true)}
                >
                  {t("aiChat.history")}
                </Button>
                <Button
                  icon={<PlusOutlined />}
                  onClick={handleCreateConversation}
                >
                  {t("aiChat.createConversation")}
                </Button>
              </Space>
            }
          >
            {messages.length > 0 ? (
              <div ref={messageListRef} className="ai-chat-message-list">
                {messages.map((item) => (
                  <div
                    key={item.id}
                    className={`ai-chat-message-row ai-chat-message-row-${item.role}`}
                  >
                    {item.role === "assistant" ? (
                      <div className="ai-chat-assistant-wrap">
                        {item.trace?.length ? (
                          <Think
                            title={resolveThinkTitle(item.trace, t)}
                            loading={item.trace.some((step) => step.status === "loading")}
                            blink={item.trace.some((step) => step.status === "loading")}
                            expanded={
                              expandedThinks[item.id] ??
                              item.trace.some((step) => step.status === "loading")
                            }
                            onExpand={(next) =>
                              setExpandedThinks((prev) => ({
                                ...prev,
                                [item.id]: next,
                              }))
                            }
                          >
                            <Flex vertical gap={8}>
                              {item.trace.map((step, stepIndex) => {
                                const detail =
                                  (typeof step.content === "string" && step.content) ||
                                  (typeof step.description === "string"
                                    ? step.description
                                    : "");
                                return (
                                  <Flex vertical key={String(step.key ?? stepIndex)}>
                                    <Typography.Text strong>
                                      {`${stepIndex + 1}. ${String(step.title ?? "")}`}
                                    </Typography.Text>
                                    {detail ? (
                                      <Typography.Text type="secondary">
                                        {detail}
                                      </Typography.Text>
                                    ) : null}
                                  </Flex>
                                );
                              })}
                            </Flex>
                          </Think>
                        ) : null}
                        {item.content ? (
                          <Bubble
                            placement="start"
                            typing={false}
                            content={
                              <div className="ai-assistant-content">
                                <MarkdownMessage content={item.content} />
                                {item.sources?.length ? (
                                  <div className="ai-source-list">
                                    <Typography.Text
                                      type="secondary"
                                      className="ai-source-title"
                                    >
                                      {t("aiChat.sources.title")}
                                    </Typography.Text>
                                    {item.sources.map((source, index) => {
                                      const label =
                                        source.title ||
                                        source.sourceType ||
                                        t("aiChat.sources.fallbackTitle", {
                                          index: index + 1,
                                        });
                                      const link = source.sourceRef || "";
                                      return (
                                        <div
                                          key={`${label}-${index}`}
                                          className="ai-source-item"
                                        >
                                          <Typography.Text className="ai-source-name">
                                            {label}
                                          </Typography.Text>
                                          <Space size={8} wrap>
                                            {source.category ? (
                                              <Typography.Text type="secondary">
                                                {source.category}
                                              </Typography.Text>
                                            ) : null}
                                            {source.similarity !== undefined ? (
                                              <Typography.Text type="secondary">
                                                {t(
                                                  "aiChat.sources.similarity",
                                                  {
                                                    value: Math.round(
                                                      source.similarity * 100,
                                                    ),
                                                  },
                                                )}
                                              </Typography.Text>
                                            ) : null}
                                            {link ? (
                                              <Button
                                                type="link"
                                                size="small"
                                                icon={<LinkOutlined />}
                                                onClick={() => {
                                                  if (
                                                    /^https?:\/\//i.test(link)
                                                  ) {
                                                    window.open(
                                                      link,
                                                      "_blank",
                                                      "noopener,noreferrer",
                                                    );
                                                  } else {
                                                    navigate(link);
                                                    onNavigate?.();
                                                  }
                                                }}
                                              >
                                                {t("aiChat.sources.viewSource")}
                                              </Button>
                                            ) : null}
                                          </Space>
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : null}
                                {item.route ? (
                                  <div className="ai-route-row">
                                    <Button
                                      type="link"
                                      icon={<LinkOutlined />}
                                      onClick={() => {
                                        navigate(item.route!);
                                        onNavigate?.();
                                      }}
                                    >
                                      {item.routeLabel || item.route}
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            }
                          />
                        ) : null}
                      </div>
                    ) : (
                      <Bubble placement="end" content={item.content} />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Flex vertical gap={18}>
                <Welcome
                  icon={<img src={chatIcon} alt="Chat Icon" />}
                  variant="borderless"
                  title={t("aiChat.welcome.title")}
                  description={t("aiChat.welcome.description")}
                />
                <Prompts
                  title={t("aiChat.promptsTitle")}
                  items={quickPrompts}
                  vertical={true}
                  onItemClick={(info: { data: { description?: unknown } }) =>
                    submitMessage(String(info.data.description || ""))
                  }
                />
              </Flex>
            )}
          </Card>

          <div className="ai-chat-footer">
            <Space style={{ marginBottom: 10}}>
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: aiSkillOptions.map((skill) => ({
                    key: skill.value,
                    label: (
                      <span className="ai-skill-option">
                        {skill.icon}
                        <span>{skill.label}</span>
                      </span>
                    ),
                  })),
                  selectedKeys: [selectedSkill],
                  onClick: ({ key }) => setSelectedSkill(key as AiSkill),
                }}
              >
                <Button>
                  <span className="ai-skill-option">
                    {activeSkill.icon}
                    <span>{activeSkill.label}</span>
                  </span>
                  <DownOutlined />
                </Button>
              </Dropdown>
              <Select
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
              {messages.length > 0 && (
                <Button
                  type="text"
                  size="small"
                  onClick={() => {
                    setMessages([]);
                  }}
                >
                  {t("aiChat.clear")}
                </Button>
              )}
              <Button
                type="text"
                icon={<SettingOutlined />}
                onClick={() => setConfigOpen(true)}
              />
            </Space>
            <Sender
              value={inputValue}
              loading={loading}
              className="ai-chat-sender"
              onChange={setInputValue}
              onSubmit={() => submitMessage(inputValue)}
              placeholder={t("aiChat.senderPlaceholder", {
                name: activeProvider.name,
              })}
            />
          </div>
        </Flex>
      </XProvider>

      <Drawer
        title={t("aiChat.history")}
        placement="left"
        width={variant === "page" ? 360 : 320}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        className="ai-chat-history-drawer"
        destroyOnHidden={false}
      >
        <Flex vertical gap={12} className="ai-chat-history">
          <Button
            type="primary"
            block
            icon={<PlusOutlined />}
            onClick={handleCreateConversation}
          >
            {t("aiChat.createConversation")}
          </Button>
          {conversationItems.length ? (
            <Conversations
              className="ai-chat-session-list"
              activeKey={activeConversationId}
              onActiveChange={(value) =>
                void handleSelectConversation(String(value))
              }
              items={conversationItems.map((item) => ({
                key: item.id,
                label: (
                  <Flex vertical className="ai-chat-session-label">
                    <Typography.Text className="ai-chat-session-title">
                      {item.title}
                    </Typography.Text>
                    <Typography.Text
                      type="secondary"
                      className="ai-chat-session-time"
                    >
                      {item.updatedAt}
                    </Typography.Text>
                  </Flex>
                ),
              }))}
              menu={(conversation) => ({
                items: [
                  {
                    key: "delete",
                    label: t("common.delete"),
                    danger: true,
                    icon: <DeleteOutlined />,
                  },
                ],
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  if (key === "delete") {
                    void handleDeleteConversation(String(conversation.key));
                  }
                },
                trigger: (
                  <Button
                    type="text"
                    size="small"
                    className="ai-chat-session-more"
                    icon={<MoreOutlined />}
                    onClick={(event) => event.stopPropagation()}
                  />
                ),
              })}
            />
          ) : (
            <Typography.Text type="secondary">
              {t("aiChat.historyEmpty")}
            </Typography.Text>
          )}
        </Flex>
      </Drawer>

      <Modal
        title={t("aiChat.config.title")}
        open={configOpen}
        onCancel={() => setConfigOpen(false)}
        width={600}
        styles={{ body: { height: "600px", overflowY: "auto" } }}
        footer={[
          <Button icon={<PlusOutlined />} onClick={addProvider} type="primary">
            {t("aiChat.config.addProvider")}
          </Button>,
        ]}
      >
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">
            {t("aiChat.config.hint")}
          </Typography.Text>
          {providers.map((provider) => (
            <Card className="ai-provider-card" key={provider.id} size="small">
              <Space vertical style={{ width: "100%" }}>
                <Space className="ai-provider-card-header">
                  <Input
                    value={provider.name}
                    onChange={(event) =>
                      updateProvider(provider.id, { name: event.target.value })
                    }
                    placeholder={t("aiChat.config.namePlaceholder")}
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
                  options={providerTypeOptions.map((option) => ({
                    ...option,
                    label:
                      option.value === "proxy"
                        ? t("aiChat.config.proxyType")
                        : option.label,
                  }))}
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
                  placeholder={t("aiChat.config.endpointPlaceholder")}
                />
                <Input
                  value={provider.model}
                  onChange={(event) =>
                    updateProvider(provider.id, { model: event.target.value })
                  }
                  placeholder={t("aiChat.config.modelPlaceholder")}
                />
                <Input.Password
                  value={provider.apiKey}
                  onChange={(event) =>
                    updateProvider(provider.id, { apiKey: event.target.value })
                  }
                  placeholder={t("aiChat.config.apiKeyPlaceholder")}
                />
              </Space>
            </Card>
          ))}
        </Flex>
      </Modal>
    </>
  );
}
