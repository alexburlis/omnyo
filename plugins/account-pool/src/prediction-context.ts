import type { PluginApi } from "@omnyo/plugin-sdk";
import { PREDICTION_CONTEXT_BUDGET_BYTES } from "./prediction-contract.js";

export const PREDICTION_CONTEXT_ERROR =
  "The conversation context is unavailable or too large. No prediction was generated.";

export { PREDICTION_CONTEXT_BUDGET_BYTES };

const PAGE_SIZE = 100;

type ContextMessage = {
  seq?: number;
  role: "user" | "automation" | "agent" | "omnyo" | "assistant";
  from?: string;
  text: string;
};

const OMITTED_HISTORY: ContextMessage = {
  role: "omnyo",
  from: "omitted-history",
  text: "Earlier messages are omitted to fit the prediction size limit.",
};

function requestSender(data: {
  senderThreadId?: string | null;
  systemMessageKind?: string;
  systemMessageSubject?:
    | {
        kind: "message-source";
        source: { kind: string; pluginId?: string; label?: string };
      }
    | { kind: string }
    | null;
}): Pick<ContextMessage, "role" | "from"> {
  if (data.senderThreadId) return { role: "agent", from: data.senderThreadId };

  if (data.systemMessageKind === "external-message") {
    const subject = data.systemMessageSubject;

    const source =
      subject && "source" in subject
        ? subject.source.kind === "plugin"
          ? `plugin ${subject.source.pluginId}`
          : `script ${subject.source.label}`
        : undefined;

    return source === undefined
      ? { role: "automation" }
      : { role: "automation", from: source };
  }

  if (
    data.systemMessageKind === undefined ||
    data.systemMessageKind === "unlabeled"
  )
    return { role: "user" };

  return { role: "omnyo", from: data.systemMessageKind };
}

type RequestedEvent = Extract<
  Awaited<ReturnType<PluginApi["sdk"]["threads"]["events"]["list"]>>[number],
  { type: "client/turn/requested" }
>;

function requestMessage(event: RequestedEvent): ContextMessage {
  return {
    seq: event.seq,
    ...requestSender(event.data),
    text: event.data.input
      .map((part) =>
        part.type === "text"
          ? part.text
          : `[${part.type} attachment; contents unavailable]`,
      )
      .join("\n"),
  };
}

function messageBytes(message: ContextMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
}

export async function predictionContext(
  api: PluginApi,
  threadId: string,
  throughSeq: number,
  signal: AbortSignal,
): Promise<string> {
  const requests = new Map<string, ContextMessage>();
  const window: ContextMessage[] = [];

  let first: ContextMessage | undefined;
  let windowBytes = 2;
  let omitted = false;
  let afterSeq = 0;
  let complete = false;

  const keep = (message: ContextMessage) => {
    window.push(message);
    windowBytes += messageBytes(message);

    if (!omitted && windowBytes <= PREDICTION_CONTEXT_BUDGET_BYTES) return;
    omitted = true;

    const headBytes =
      messageBytes(OMITTED_HISTORY) + (first ? messageBytes(first) : 0);

    while (
      window.length > 0 &&
      (windowBytes + headBytes > PREDICTION_CONTEXT_BUDGET_BYTES ||
        (first?.seq !== undefined && (window[0]?.seq ?? 0) <= first.seq))
    ) {
      const dropped = window.shift();

      if (dropped) windowBytes -= messageBytes(dropped);
    }
  };

  while (afterSeq < throughSeq) {
    signal.throwIfAborted();

    const events = await api.sdk.threads.events
      .list({
        threadId,
        types: [
          "client/turn/requested",
          "turn/input/accepted",
          "item/completed",
        ],
        afterSeq: String(afterSeq),
        beforeSeq: String(throughSeq + 1),
        order: "asc",
        limit: String(PAGE_SIZE),
        signal,
      })
      .catch(() => {
        throw new Error(PREDICTION_CONTEXT_ERROR);
      });

    for (const event of events) {
      if (event.seq <= afterSeq || event.seq > throughSeq)
        throw new Error(PREDICTION_CONTEXT_ERROR);
      afterSeq = event.seq;

      if (event.type === "client/turn/requested") {
        requests.set(event.data.requestId, requestMessage(event));
      } else if (event.type === "turn/input/accepted") {
        const request = requests.get(event.data.clientRequestId);

        if (!request) throw new Error(PREDICTION_CONTEXT_ERROR);
        requests.delete(event.data.clientRequestId);
        first ??= request;
        keep(request);
      } else if (event.type === "item/completed") {
        const item = event.data.item;

        if (
          !item.parentToolCallId &&
          (item.type === "agentMessage" || item.type === "plan")
        )
          keep({ seq: event.seq, role: "assistant", text: item.text });
      }
    }

    if (events.length < PAGE_SIZE || afterSeq === throughSeq) {
      complete = true;
      break;
    }
  }

  const context = omitted
    ? [...(first ? [first] : []), OMITTED_HISTORY, ...window]
    : window;

  const serialized = JSON.stringify(context);

  if (
    !complete ||
    !context.some(
      (message) => message.seq !== undefined && message.role !== "assistant",
    ) ||
    !context.some((message) => message.role === "assistant") ||
    Buffer.byteLength(serialized, "utf8") > PREDICTION_CONTEXT_BUDGET_BYTES
  )
    throw new Error(PREDICTION_CONTEXT_ERROR);

  return serialized;
}
