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
  page: Annotation<string | undefined>,
  currentFocus: Annotation<unknown | undefined>,
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

export async function runChatGraph(input: AiChatRequest): Promise<AiChatResult> {
  const state = {
    sessionId: input.session_id,
    userId: input.user_id,
    text: input.text,
    skill: input.skill ?? "auto",
    provider: input.provider,
    page: input.context?.page,
    currentFocus: input.context?.current_focus,
    recentMessages: input.context?.recent_messages ?? [],
  };

  const result = (await compiled.invoke(state)) as AiGraphState;

  return {
    status: "success",
    reply: result.reply || "已处理。",
    focus: result.focus,
    need_confirmation: result.needConfirmation,
    next_questions: result.nextQuestions,
    data: {
      intent: result.intent,
      domain: result.domain,
      plan: result.plan,
      toolResults: result.toolResults,
    },
  };
}
