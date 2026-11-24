import fs from "node:fs/promises";

export const MAX_LINE_BYTES = 16 * 1024 * 1024;

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export interface LineReadStats {
  oversizedLines: number;
  bytesRead: number;
}

export interface ReadLinesOptions {
  readonly maxLineBytes?: number;
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
  readonly stats?: LineReadStats;
}

export function createLineReadStats(): LineReadStats {
  return { oversizedLines: 0, bytesRead: 0 };
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export async function* readLines(
  filePath: string,
  options: ReadLinesOptions = {},
): AsyncGenerator<string> {
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const stats = options.stats ?? createLineReadStats();
  const handle = await fs.open(filePath, "r");

  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let discarding = false;
    let position = 0;

    for (;;) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);

      if (bytesRead === 0) break;
      position += bytesRead;
      stats.bytesRead = position;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;

      while (start < bytesRead) {
        const newline = chunk.indexOf(NEWLINE, start);
        const end = newline === -1 ? bytesRead : newline;
        const segmentBytes = end - start;

        if (!discarding && pendingBytes + segmentBytes > maxLineBytes) {
          discarding = true;
          pending = [];
          pendingBytes = 0;
        }

        if (newline === -1) {
          if (!discarding && segmentBytes > 0) {
            pending.push(Buffer.from(chunk.subarray(start, end)));
            pendingBytes += segmentBytes;
          }

          break;
        }

        start = newline + 1;

        if (discarding) {
          stats.oversizedLines += 1;
          discarding = false;
          continue;
        }

        let line: string;

        if (pending.length === 0) {
          line = chunk.toString("utf8", end - segmentBytes, end);
        } else {
          pending.push(chunk.subarray(end - segmentBytes, end));
          line = Buffer.concat(pending).toString("utf8");
          pending = [];
          pendingBytes = 0;
        }

        line = stripCarriageReturn(line);

        if (line.length > 0) yield line;
      }
    }

    if (discarding) {
      stats.oversizedLines += 1;
    } else if (pendingBytes > 0) {
      const line = stripCarriageReturn(Buffer.concat(pending).toString("utf8"));

      if (line.length > 0) yield line;
    }
  } finally {
    await handle.close();
  }
}

export async function readFirstLine(
  filePath: string,
  options: ReadLinesOptions = {},
): Promise<string | null> {
  for await (const line of readLines(filePath, options)) return line;

  return null;
}

export interface TailLines {
  readonly lines: string[];
  readonly reachedStart: boolean;
}

export async function readTailLines(
  filePath: string,
  maxBytes: number,
): Promise<TailLines> {
  const handle = await fs.open(filePath, "r");

  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;

    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        start + offset,
      );

      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    let view = buffer.subarray(0, offset);

    if (start > 0) {
      const firstNewline = view.indexOf(NEWLINE);

      view =
        firstNewline === -1
          ? view.subarray(0, 0)
          : view.subarray(firstNewline + 1);
    }

    const lines = view
      .toString("utf8")
      .split("\n")
      .map(stripCarriageReturn)
      .filter((line) => line.length > 0);

    return { lines, reachedStart: start === 0 };
  } finally {
    await handle.close();
  }
}

export type JsonRecord = Readonly<Record<string, unknown>>;

export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function parseJsonRecord(line: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

export function stringField(
  record: JsonRecord | null,
  key: string,
): string | null {
  const value = record?.[key];

  return typeof value === "string" ? value : null;
}

export function numberField(
  record: JsonRecord | null,
  key: string,
): number | null {
  const value = record?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function recordField(
  record: JsonRecord | null,
  key: string,
): JsonRecord | null {
  return asRecord(record?.[key]);
}

export function arrayField(
  record: JsonRecord | null,
  key: string,
): readonly unknown[] {
  const value = record?.[key];

  return Array.isArray(value) ? value : [];
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
