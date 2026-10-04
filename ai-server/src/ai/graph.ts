import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import type { AiChatRequest, AiChatResult, AiGraphState } from "./state.js";
import { intentRouterNode } from "./nodes/intentRouter.js";
import { contextLoaderNode } from "./nodes/contextLoader.js";
import { plannerNode } from "./nodes/planner.js";
import { shouldContinuePlan, toolExecutorNode } from "./nodes/toolExecutor.js";
import { memoryWriterNode } from "./nodes/memoryWriter.js";
import { responseComposerNode } from "./nodes/responseComposer.js";
import { streamContext } from "./streamContext.js";

/** 多步计划的硬上限（防计划自激 / 死循环） */
const MAX_PLAN_STEPS = 5;

const State = Annotation.Root({
  sessionId: Annotation<string>,
  userId: Annotation<number | undefined>,
  tenantId: Annotation<number | undefined>,
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
  stepInput: Annotation<Record<string, unknown> | undefined>,
  planCursor: Annotation<number | undefined>,
  planOutputs: Annotation<Array<Record<string, unknown>> | undefined>,
  toolResults: Annotation<unknown[]>({
    // 多步计划：各步结果累积（responseComposer 取最后一条作为主回复）
    reducer: (prev, next) => [...((prev as unknown[]) || []), ...((next as unknown[]) || [])],
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
  // 多步计划循环：还有下一步就回到 toolExecutor，否则进入收尾
  .addConditionalEdges(
    "toolExecutor",
    (state) => (shouldContinuePlan(state as AiGraphState) ? "toolExecutor" : "memoryWriter"),
    { toolExecutor: "toolExecutor", memoryWriter: "memoryWriter" },
  )
  .addEdge("memoryWriter", "responseComposer")
  .addEdge("responseComposer", END);

const compiled = graph.compile();

const buildState = (input: AiChatRequest): AiGraphState => ({
  sessionId: input.session_id,
  userId: input.user_id,
  tenantId: input.tenant_id,
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
  planCursor: 0,
  planOutputs: [],
});

export type StreamEvent =
  | { type: "step"; step: string; message: string; data?: unknown }
  /** LLM 增量文本（#7 真流式）：前端边收边渲染，final 事件再整体校准 */
  | { type: "delta"; text: string }
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
  // 真流式（#7）：整条节点链包在 streamContext 里，节点内生成 LLM 文本时
  // 调 emitDelta()，这里转发成 delta 事件。无节点产生增量时行为与旧版一致。
  return streamContext.run(async (text) => onEvent({ type: "delta", text }), async () => {
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

    // 多步计划：逐步执行（写操作产出待确认草稿 / 某步失败 / 计划跑完即停）
    let guard = 0;
    while (guard < MAX_PLAN_STEPS) {
      guard += 1;
      const plan = Array.isArray(state.plan) ? state.plan : [];
      const cursor = typeof state.planCursor === "number" ? state.planCursor : 0;
      const current = plan[cursor] as { step?: string; tool?: string } | undefined;
      await onEvent({
        type: "step",
        step: "toolExecutor",
        message: current?.step ? `正在执行：${current.step}（${guard}）` : "正在执行工具...",
        data: { step: current?.step, tool: current?.tool, index: cursor },
      });
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
      if (!shouldContinuePlan(state)) break;
    }

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
  });
}
