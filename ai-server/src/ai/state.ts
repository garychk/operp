export type AiSkill = "auto" | "analysis" | "create" | "action" | "baq" | "chat";

export interface AiChatRequest {
  session_id: string;
  user_id?: number;
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
  need_confirmation?: boolean;
  next_questions?: string[];
  data?: unknown;
}

export interface AiGraphState {
  sessionId: string;
  userId?: number;
  text: string;
  skill: AiSkill;
  provider?: AiChatRequest["provider"];
  page?: string;
  currentFocus?: unknown;
  recentMessages: unknown[];
  intent?: string;
  domain?: string;
  plan?: unknown;
  toolResults?: unknown[];
  reply?: string;
  focus?: unknown;
  needConfirmation?: boolean;
  nextQuestions?: string[];
}
