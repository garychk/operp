import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import type { AiChatRequest, AiChatResult, AiGraphState } from "./state.js";
import { intentRouterNode } from "./nodes/intentRouter.js";
import { contextLoaderNode } from "./nodes/contextLoader.js";
import { plannerNode } from "./nodes/planner.js";
import { toolExecutorNode } from "./nodes/toolExecutor.js";
import { memoryWriterNode } from "./nodes/memoryWriter.js";
import { responseComposerNode } from "./nodes/responseComposer.js";

const State = Annotation.Root({
  sessionId: Annotation<string>,
  userId: Annotation<number | undefined>,
  text: Annotation<string>,
  skill: Annotation<AiGraphState["skill"]>,
  provider: Annotation<AiGraphState["provider"]>,
  action: Annotation<AiGraphState["action"]>,
  page: Annotation<string | undefined>,
  currentFocus: Annotation<unknown | undefined>,
  target: Annotation<string | undefined>,
  queryMode: Annotation<AiGraphState["queryMode"]>,
  responseMode: Annotation<AiGraphState["responseMode"]>,
  confidence: Annotation<number | undefined>,
  memory: Annotation<AiGraphState["memory"]>,
  recentMessages: Annotation<unknown[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  intent: Annotation<string | undefined>,
  domain: Annotation<string | undefined>,
  plan: Annotation<unknown | undefined>,
  toolResults: Annotation<unknown[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  reply: Annotation<string | undefined>,
  focus: Annotation<unknown | undefined>,
  needConfirmation: Annotation<boolean | undefined>,
  nextQuestions: Annotation<string[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
});

const graph = new StateGraph(State)
  .addNode("contextLoader", contextLoaderNode)
  .addNode("intentRouter", intentRouterNode)
  .addNode("planner", plannerNode)
  .addNode("toolExecutor", toolExecutorNode)
  .addNode("memoryWriter", memoryWriterNode)
  .addNode("responseComposer", responseComposerNode)
  .addEdge(START, "contextLoader")
  .addEdge("contextLoader", "intentRouter")
  .addEdge("intentRouter", "planner")
  .addEdge("planner", "toolExecutor")
  .addEdge("toolExecutor", "memoryWriter")
  .addEdge("memoryWriter", "responseComposer")
  .addEdge("responseComposer", END);

const compiled = graph.compile();

const buildState = (input: AiChatRequest): AiGraphState => ({
  sessionId: input.session_id,
  userId: input.user_id,
  text: input.text,
  skill: input.skill ?? "auto",
  provider: input.provider,
  page: input.context?.page,
  currentFocus: input.context?.current_focus,
  target: undefined,
  queryMode: undefined,
  responseMode: undefined,
  confidence: undefined,
  memory: undefined,
  recentMessages: input.context?.recent_messages ?? [],
});

export type StreamEvent =
  | { type: "step"; step: string; message: string; data?: unknown }
  | { type: "final"; result: AiChatResult };

export async function runChatGraph(input: AiChatRequest): Promise<AiChatResult> {
  const result = (await compiled.invoke(buildState(input))) as AiGraphState;

  return {
    status: "success",
    reply: result.reply || "已处理。",
    focus: result.focus,
    route: result.route,
    routeLabel: result.routeLabel,
    sources: result.sources,
    need_confirmation: result.needConfirmation,
    next_questions: result.nextQuestions,
    data: {
      intent: result.intent,
      domain: result.domain,
      target: result.target,
      queryMode: result.queryMode,
      responseMode: result.responseMode,
      confidence: result.confidence,
      plan: result.plan,
      toolResults: result.toolResults,
      sources: result.sources,
    },
  };
}

export async function runChatGraphStream(
  input: AiChatRequest,
  onEvent: (event: StreamEvent) => void | Promise<void>,
): Promise<AiChatResult> {
  let state = buildState(input);

  await onEvent({ type: "step", step: "contextLoader", message: "正在加载上下文..." });
  state = await contextLoaderNode(state);
  await onEvent({
    type: "step",
    step: "contextLoader",
    message: "上下文已加载",
    data: {
      recentMessages: state.recentMessages.length,
      page: state.page,
      hasFocus: Boolean(state.currentFocus),
    },
  });

  await onEvent({ type: "step", step: "intentRouter", message: "正在识别意图..." });
  state = await intentRouterNode(state);
  await onEvent({
    type: "step",
    step: "intentRouter",
    message: "意图已识别",
    data: {
      intent: state.intent,
      domain: state.domain,
    },
  });

  await onEvent({ type: "step", step: "planner", message: "正在拆解任务..." });
  state = await plannerNode(state);
  await onEvent({
    type: "step",
    step: "planner",
    message: "任务已拆解",
    data: {
      plan: state.plan,
    },
  });

  await onEvent({ type: "step", step: "toolExecutor", message: "正在执行工具..." });
  state = await toolExecutorNode(state);
  await onEvent({
    type: "step",
    step: "toolExecutor",
    message: "工具执行完成",
    data: {
      toolResults: state.toolResults,
      reply: state.reply,
      sources: state.sources,
      needConfirmation: state.needConfirmation,
      nextQuestions: state.nextQuestions,
    },
  });

  await onEvent({ type: "step", step: "memoryWriter", message: "正在写入会话记忆..." });
  state = await memoryWriterNode(state);
  await onEvent({
    type: "step",
    step: "memoryWriter",
    message: "会话记忆已写入",
  });

  await onEvent({ type: "step", step: "responseComposer", message: "正在整理回复..." });
  state = await responseComposerNode(state);
  await onEvent({
    type: "step",
    step: "responseComposer",
    message: "回复已整理",
    data: {
      reply: state.reply,
    },
  });

  const result: AiChatResult = {
    status: "success",
    reply: state.reply || "已处理。",
    focus: state.focus,
    route: state.route,
    routeLabel: state.routeLabel,
    sources: state.sources,
    need_confirmation: state.needConfirmation,
    next_questions: state.nextQuestions,
    data: {
      intent: state.intent,
      domain: state.domain,
      target: state.target,
      queryMode: state.queryMode,
      responseMode: state.responseMode,
      confidence: state.confidence,
      plan: state.plan,
      toolResults: state.toolResults,
      sources: state.sources,
    },
  };

  await onEvent({ type: "final", result });
  return result;
}
