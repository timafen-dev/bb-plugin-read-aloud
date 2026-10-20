import type { ChunkAudio, ChunkJobStatus } from "./speech-jobs.ts";
export type SpeechRpc = (
  method: string,
  input: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
function sleep(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, 500);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class ChunkClient {
  private jobs = new Map<string, string>();
  private controller = new AbortController();
  private rpc: SpeechRpc;
  private wait: (signal: AbortSignal) => Promise<void>;
  constructor(rpc: SpeechRpc, wait = sleep) {
    this.rpc = rpc;
    this.wait = wait;
  }
  async get(
    chunk: string,
    threadId: string | null,
    format: string,
    retry = false,
  ): Promise<ChunkAudio> {
    const signal = this.controller.signal;
    if (signal.aborted) throw signal.reason;
    const key = JSON.stringify([chunk, threadId, format]);
    const previous = this.jobs.get(key);
    const { jobId } = (await this.rpc(
      "requestChunk",
      {
        chunk,
        threadId,
        format,
        ...(retry && previous ? { retryJobId: previous } : {}),
      },
      signal,
    )) as { jobId: string };
    this.jobs.set(key, jobId);
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const status = (await this.rpc(
        "chunkStatus",
        { jobId },
        signal,
      )) as ChunkJobStatus;
      if (status.state === "ready" && status.audio) return status.audio;
      if (status.state === "error")
        throw Error(status.message ?? "Не удалось подготовить аудио");
      await this.wait(signal);
    }
  }
  dispose() {
    this.controller.abort(new DOMException("Reading disposed", "AbortError"));
    this.jobs.clear();
  }
}
