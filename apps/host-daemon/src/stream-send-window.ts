const MIN_WINDOW_BYTES = 64 * 1024;

const INITIAL_WINDOW_BYTES = 256 * 1024;

const MAX_WINDOW_BYTES = 4 * 1024 * 1024;

const WINDOW_STEP_BYTES = 64 * 1024;

const QUEUED_BYTES_LOW = 48 * 1024;

const QUEUED_BYTES_HIGH = 144 * 1024;

const QUEUE_DELAY_LOW_MS = 5;

const QUEUE_DELAY_HIGH_MS = 10;

const BASE_RTT_PERIOD_MS = 10_000;

const RTT_SAMPLE_MIN_BYTES = 32 * 1024;

interface StreamWrite {
  bytes: number;
  sentAtMs: number;
}

export class StreamSendWindow {
  private readonly writes: StreamWrite[] = [];
  private inFlightBytes = 0;
  private windowBytes = INITIAL_WINDOW_BYTES;
  private baseRttMs = Number.POSITIVE_INFINITY;
  private previousBaseRttMs = Number.POSITIVE_INFINITY;
  private baseRttPeriodStartedAtMs: number | null = null;

  get window(): number {
    return this.windowBytes;
  }

  get open(): boolean {
    return this.inFlightBytes < this.windowBytes;
  }

  recordWrite(bytes: number, nowMs: number): void {
    this.writes.push({ bytes, sentAtMs: nowMs });
    this.inFlightBytes += bytes;
  }

  acknowledge(bytes: number, nowMs: number): boolean {
    const write = this.writes[0];

    if (write?.bytes !== bytes) return false;

    const inFlightBefore = this.inFlightBytes;
    this.writes.shift();
    this.inFlightBytes -= bytes;

    if (bytes < RTT_SAMPLE_MIN_BYTES) return true;

    const rttMs = nowMs - write.sentAtMs;
    const baseRttMs = this.observeRtt(rttMs, nowMs);
    const queueDelayMs = rttMs - baseRttMs;

    const queuedBytes =
      rttMs > 0 ? (this.windowBytes * queueDelayMs) / rttMs : 0;

    const step = (WINDOW_STEP_BYTES * bytes) / this.windowBytes;

    if (queuedBytes > QUEUED_BYTES_HIGH && queueDelayMs > QUEUE_DELAY_HIGH_MS) {
      this.windowBytes = Math.max(MIN_WINDOW_BYTES, this.windowBytes - step);
    } else if (
      (queuedBytes < QUEUED_BYTES_LOW || queueDelayMs < QUEUE_DELAY_LOW_MS) &&
      inFlightBefore >= this.windowBytes / 2
    ) {
      this.windowBytes = Math.min(MAX_WINDOW_BYTES, this.windowBytes + step);
    }

    return true;
  }

  reset(): void {
    this.writes.length = 0;
    this.inFlightBytes = 0;
  }

  private observeRtt(rttMs: number, nowMs: number): number {
    if (
      this.baseRttPeriodStartedAtMs === null ||
      nowMs - this.baseRttPeriodStartedAtMs >= BASE_RTT_PERIOD_MS
    ) {
      this.previousBaseRttMs = this.baseRttMs;
      this.baseRttMs = Number.POSITIVE_INFINITY;
      this.baseRttPeriodStartedAtMs = nowMs;
    }

    this.baseRttMs = Math.min(this.baseRttMs, rttMs);

    return Math.min(this.baseRttMs, this.previousBaseRttMs);
  }
}
