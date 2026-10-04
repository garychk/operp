import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 流式增量下发通道（#7 真流式）。
 *
 * 为什么用 AsyncLocalStorage 而不是把回调塞进 LangGraph state：
 * - state 会被序列化 / 快照，塞函数不干净；
 * - ALS 天然按请求隔离，并发对话互不串扰。
 *
 * 用法：
 *   runChatGraphStream 里用 streamContext.run(sink, ...) 包住整条节点链；
 *   toolExecutor 等节点里生成 LLM 文本时调 emitDelta(piece) ——
 *   没有sink（非流式请求）时 emitDelta 是安全 no-op。
 */
export type DeltaSink = (text: string) => void;

const storage = new AsyncLocalStorage<DeltaSink>();

export const streamContext = {
  run: <T>(sink: DeltaSink, fn: () => Promise<T>): Promise<T> => storage.run(sink, fn),
};

export const emitDelta = (text: string): void => {
  if (!text) return;
  const sink = storage.getStore();
  if (sink) sink(text);
};
