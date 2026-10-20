/** One user-activated audio context per app window, reused across all chunks. */
let context: AudioContext | null = null;
let activation: Promise<void> | null = null;

export function activatePlayback(): void {
  if (context === null || context.state === "closed") {
    context = new AudioContext();
  }
  if (context.state === "running") activation = null;
  else {
    // Call resume synchronously inside the actual click, before fetching audio.
    activation = context.resume();
    // The reading awaits the same promise; prevent an early unhandled rejection.
    void activation.catch(() => {});
  }
}

export function disposePlayback(): void {
  const previous = context;
  context = null;
  activation = null;
  if (previous !== null && previous.state !== "closed") {
    void previous.close().catch(() => {});
  }
}

export async function decodePlayback(bytes: Uint8Array): Promise<AudioBuffer> {
  const clock = context;
  if (clock === null) throw new Error("Нажми Play ещё раз, чтобы разрешить звук.");
  return clock.decodeAudioData(bytes.slice().buffer);
}

export class ChunkPlayback {
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private duration = 0;
  private cancelled = false;
  private settle: (() => void) | null = null;
  private clock: AudioContext | null = null;

  get currentTime(): number {
    return Math.min(
      this.duration,
      this.offset + (this.clock === null ? 0 : this.clock.currentTime - this.startedAt),
    );
  }

  stop(): void {
    this.cancelled = true;
    const source = this.source;
    this.source = null;
    if (source !== null) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.settle?.();
    this.settle = null;
  }

  async play(bytes: Uint8Array, startAt = 0): Promise<void> {
    const buffer = await decodePlayback(bytes);
    if (!this.cancelled) await this.playBuffer(buffer, startAt);
  }

  async playBuffer(buffer: AudioBuffer, startAt = 0): Promise<void> {
    const clock = context;
    if (clock === null) throw new Error("Нажми Play ещё раз, чтобы разрешить звук.");
    if (activation !== null) await activation;
    if (this.cancelled) return;
    if (clock.state !== "running") {
      throw new Error("Браузер приостановил звук. Нажми Play ещё раз.");
    }
    this.clock = clock;
    // The same decoded rendition is reused when seeking and resuming.
    if (this.cancelled) return;
    this.offset = Math.min(Math.max(0, startAt), buffer.duration);
    this.duration = buffer.duration;
    if (this.offset >= this.duration) return;
    const source = clock.createBufferSource();
    source.buffer = buffer;
    source.connect(clock.destination);
    this.source = source;
    this.startedAt = clock.currentTime;
    await new Promise<void>((resolve) => {
      this.settle = resolve;
      source.onended = () => {
        this.source = null;
        this.settle = null;
        source.disconnect();
        resolve();
      };
      source.start(0, this.offset);
    });
  }
}
