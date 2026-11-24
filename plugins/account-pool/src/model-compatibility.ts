import { z } from "zod";
import type {
  Account,
  ModelRejection,
  PredictionRejection,
} from "./contracts.js";

export const MODEL_REJECTION_TTL_MS = 24 * 60 * 60 * 1_000;

export const PREDICTION_REJECTION_TTL_MS = 60 * 60 * 1_000;

const rejectionSentence = (model: string) =>
  `The '${model}' model is not supported when using Codex with a ChatGPT account`;

const MAX_INSPECTED_BYTES = 64 * 1024;

const MAX_INSPECTION_MS = 2_000;

const PENDING_EVENT_TYPES = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
]);

const errorFieldsSchema = z
  .object({
    message: z.unknown().optional(),
    detail: z.unknown().optional(),
  })
  .passthrough();

const errorPayloadSchema = errorFieldsSchema.extend({
  type: z.unknown().optional(),
  error: errorFieldsSchema.nullish().catch(null),
  response: z
    .object({ error: errorFieldsSchema.nullish().catch(null) })
    .passthrough()
    .nullish()
    .catch(null),
});

export interface ModelRejectionInspection {
  rejected: boolean;
  response: Response;
}

export function isActiveModelRejection(
  account: Pick<Account, "id" | "subscriptionType">,
  rejection: ModelRejection,
  now: number,
): boolean {
  return (
    rejection.accountId === account.id &&
    rejection.plan === account.subscriptionType &&
    now - rejection.observedAt < MODEL_REJECTION_TTL_MS
  );
}

export function rejectsOtherModel(
  account: Pick<Account, "id" | "subscriptionType">,
  rejections: readonly ModelRejection[],
  model: string,
): boolean {
  return rejections.some(
    (rejection) =>
      rejection.accountId === account.id &&
      rejection.plan === account.subscriptionType &&
      rejection.model !== model,
  );
}

export function isActivePredictionRejection(
  account: Pick<Account, "id" | "subscriptionType">,
  rejection: PredictionRejection | null,
  now: number,
): rejection is PredictionRejection {
  return (
    rejection !== null &&
    rejection.accountId === account.id &&
    rejection.plan === account.subscriptionType &&
    now - rejection.observedAt < PREDICTION_REJECTION_TTL_MS
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rejectsModel(payload: unknown, model: string): boolean {
  const parsed = errorPayloadSchema.safeParse(payload);

  if (!parsed.success) return false;
  const sentence = rejectionSentence(model);

  return [parsed.data, parsed.data.error, parsed.data.response?.error].some(
    (fields) =>
      fields !== null &&
      fields !== undefined &&
      [fields.message, fields.detail].some(
        (text) => typeof text === "string" && text.trim().startsWith(sentence),
      ),
  );
}

function eventStreamVerdict(text: string, model: string): boolean | null {
  const blocks = text.split(/\r?\n\r?\n/u);
  blocks.pop();

  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);

    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");

    if (data === "") continue;
    const event = parseJson(data);
    const parsed = errorPayloadSchema.safeParse(event);

    const declared = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();

    const type =
      parsed.success && typeof parsed.data.type === "string"
        ? parsed.data.type
        : declared;

    if (type !== undefined && PENDING_EVENT_TYPES.has(type)) continue;

    return (
      (type === "response.failed" || type === "error") &&
      rejectsModel(event, model)
    );
  }

  return null;
}

function inspectedFormat(response: Response): "event-stream" | "json" | null {
  if (response.body === null) return null;

  if (response.ok)
    return response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "text/event-stream"
      ? "event-stream"
      : null;

  return response.status >= 400 &&
    response.status < 500 &&
    response.status !== 429
    ? "json"
    : null;
}

function replay(
  response: Response,
  chunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  carried: Promise<ReadableStreamReadResult<Uint8Array>> | null,
  done: boolean,
  readError: { cause: unknown } | null,
): Response {
  const pending = [...chunks];
  let next = carried;

  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const buffered = pending.shift();

        if (buffered !== undefined) {
          controller.enqueue(buffered);

          return;
        }

        if (readError !== null) {
          controller.error(readError.cause);

          return;
        }

        if (done) {
          controller.close();

          return;
        }

        const read = next ?? reader.read();
        next = null;
        const chunk = await read;

        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
}

export async function inspectCodexModelRejection(
  response: Response,
  model: string,
  signal: AbortSignal,
): Promise<ModelRejectionInspection> {
  const format = inspectedFormat(response);

  if (format === null || response.body === null || signal.aborted)
    return { rejected: false, response };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let text = "";
  let size = 0;
  let verdict: boolean | null = null;
  let done = false;
  let readError: { cause: unknown } | null = null;

  let carried: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MAX_INSPECTION_MS);
  });

  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };

  signal.addEventListener("abort", abort, { once: true });

  try {
    while (verdict === null && size < MAX_INSPECTED_BYTES) {
      const read = reader.read();
      read.catch(() => undefined);
      const chunk = await Promise.race([read, deadline]);

      if (chunk === null) {
        carried = read;
        break;
      }

      if (chunk.done) {
        done = true;
        break;
      }

      chunks.push(chunk.value);
      size += chunk.value.byteLength;
      text += decoder.decode(chunk.value, { stream: true });

      if (format === "event-stream") verdict = eventStreamVerdict(text, model);
    }
  } catch (error) {
    readError = { cause: error };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }

  if (done && !signal.aborted) {
    text += decoder.decode();
    verdict =
      format === "json"
        ? rejectsModel(parseJson(text), model)
        : (verdict ?? eventStreamVerdict(`${text}\n\n`, model));
  }

  return {
    rejected: readError === null && !signal.aborted && verdict === true,
    response: replay(response, chunks, reader, carried, done, readError),
  };
}
