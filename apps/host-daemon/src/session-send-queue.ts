import type { HostDaemonDaemonWsMessage } from "@omnyo/host-daemon-contract";

interface QueuedPayload {
  bytes: number;
}

export function sessionSendStreamKey(
  message: HostDaemonDaemonWsMessage,
): string | null {
  switch (message.type) {
    case "terminal.output":
    case "terminal.opened":
    case "terminal.replay":
    case "terminal.error":
    case "terminal.exited":
      return `terminal\u0000${message.terminalId}`;
    case "host-rpc.response":
      return message.commandType === "host.read_file_chunk"
        ? `file-chunk\u0000${message.requestId}`
        : null;
    default:
      return null;
  }
}

export class SessionSendQueue<TPayload extends QueuedPayload> {
  private readonly streams = new Map<string, TPayload[]>();
  private queuedBytes = 0;

  get bytes(): number {
    return this.queuedBytes;
  }

  hasStream(key: string): boolean {
    return this.streams.has(key);
  }

  push(stream: string, payload: TPayload): void {
    this.queuedBytes += payload.bytes;
    const queue = this.streams.get(stream);

    if (queue) {
      queue.push(payload);

      return;
    }

    this.streams.set(stream, [payload]);
  }

  takeNextStreamPayload(): TPayload | undefined {
    const next = this.streams.entries().next();

    if (next.done) return undefined;

    const [key, queue] = next.value;
    const payload = queue.shift();
    this.streams.delete(key);

    if (queue.length > 0) this.streams.set(key, queue);

    if (payload) this.queuedBytes -= payload.bytes;

    return payload;
  }

  clear(): TPayload[] {
    const pending = [...this.streams.values()].flat();
    this.streams.clear();
    this.queuedBytes = 0;

    return pending;
  }
}
