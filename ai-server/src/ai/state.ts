export type AiSkill = "auto" | "analysis" | "create" | "action" | "baq" | "chat";
export type AiIntent =
  | "chat"
  | "knowledge"
  | "create"
  | "update"
  | "baq"
  | "analysis"
  /** 单据类操作：建单 / 过账 / 审批 / 转单 / 查询（第三批） */
  | "document"
  /** 菜单导航：「XX 菜单在哪里 / 菜单地址是什么」→ 回菜单名 + 可点击跳转链接 */
  | "navigation"
  /** 会话里有待确认草稿且用户回复了「确认」 */
  | "confirm_execute"
  /** 会话里有待确认草稿且用户回复了「取消」 */
  | "cancel_action";
export type AiAction = "create" | "update" | "chat";
export type AiQueryMode =
  | "count"
  | "list"
  | "summary"
  | "detail"
  | "trend"
  | "compare"
  | "exception"
  | "definition"
  | "answer";
export type AiResponseMode = "text" | "table" | "card" | "link" | "follow_up";

export interface AiSessionMemory {
  session_id: string;
  user_id?: number;
  recent_messages: unknown[];
  last_intent?: string;
  last_target?: string;
  last_query_mode?: string;
  last_response_mode?: string;
  last_route?: string;
  last_route_label?: string;
  last_focus?: unknown;
  updated_at?: string;
}

export interface AiChatRequest {
  session_id: string;
  user_id?: number;
  /**
   * 显式指定租户。普通用户只能指定自己所属的租户，超管可跨租户。
   * 不传则由服务端从 sys_users.tenant_id 解析。
   */
  tenant_id?: number;
  text: string;
  skill?: AiSkill;
  provider?: {
    id?: string;
    name?: string;
    endpoint?: string;
    model?: string;
    apiType?: "proxy" | "ollama";
    apiKey?: string;
    temperature?: number;
  };
  context?: {
    page?: string;
    current_focus?: unknown;
    recent_messages?: unknown[];
  };
}

export interface AiChatResult {
  status: "success" | "error" | "need_confirmation" | "needs_more";
  reply: string;
  focus?: unknown;
  route?: string;
  routeLabel?: string;
  sources?: unknown[];
  need_confirmation?: boolean;
  next_questions?: string[];
  data?: unknown;
}

export interface AiGraphState {
  sessionId: string;
  userId?: number;
  /** 本次请求解析出的租户。为空表示未解析成功，业务数据操作必须拒绝。 */
  tenantId?: number;
  text: string;
  skill: AiSkill;
  provider?: AiChatRequest["provider"];
  page?: string;
  currentFocus?: unknown;
  recentMessages: unknown[];
  memory?: AiSessionMemory | null;
  /** 会话里最新一条待确认草稿（contextLoader 预取，「确认/取消」短路命中用） */
  pendingAction?: { id: number; actionType: string; entityKey: string; remainingPlan?: unknown[] } | null;
  intent?: AiIntent;
  action?: AiAction;
  domain?: string;
  target?: string;
  queryMode?: AiQueryMode;
  responseMode?: AiResponseMode;
  confidence?: number;
  plan?: unknown;
  /** 当前步骤的输入（planner 产出，占位符已替换） */
  stepInput?: Record<string, unknown>;
  /** 多步计划执行游标：下一个要执行的步骤下标 */
  planCursor?: number;
  /** 当前步骤之后剩余的计划（写操作产草稿时冻结进 pending context，确认后续跑） */
  planRemaining?: unknown[];
  /** 各步骤产出（多步计划里后续步骤可用 $prev.xxx 引用上一步产出） */
  planOutputs?: Array<Record<string, unknown>>;
  toolResults?: unknown[];
  sources?: unknown[];
  reply?: string;
  focus?: unknown;
  route?: string;
  routeLabel?: string;
  needConfirmation?: boolean;
  nextQuestions?: string[];
}
