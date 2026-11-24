import { createInterface } from "node:readline/promises";
import {
  getErrorMessage,
  reasoningLevelSchema,
  reasoningLevelValues,
  type ReasoningLevel,
} from "@omnyo/domain";
import { noteJsonPayloadWritten } from "../cli-error-output.js";
import type { ResolvedId } from "../context-env.js";

export {
  type ResolvedId,
  requireThreadId,
  requireThreadIdOrSelf,
} from "../context-env.js";

const REASONING_LEVELS: readonly ReasoningLevel[] = reasoningLevelValues;

export interface JsonOutputOptions {
  json?: boolean;
}

export function outputJson(opts: JsonOutputOptions, data: unknown): boolean {
  if (!opts.json) return false;
  console.log(JSON.stringify(data, null, 2));
  noteJsonPayloadWritten();

  return true;
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function printThreadContextLabel(resolved: ResolvedId): void {
  if (resolved.source === "env") {
    console.error(`Thread ${resolved.id} (from OMNYO_THREAD_ID)`);
  }
}

export async function confirmDestructiveAction(
  message: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Refusing destructive action without an interactive terminal. Re-run with --yes to confirm.",
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await readline.question(`${message} [y/N] `);
    const normalized = answer.trim().toLowerCase();

    return normalized === "y" || normalized === "yes";
  } finally {
    readline.close();
  }
}

export function parseReasoningLevel(
  value: string | undefined,
): ReasoningLevel | undefined {
  if (value === undefined) return undefined;
  const parsed = reasoningLevelSchema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(
    `Invalid reasoning level '${value}'. Expected a level id the model lists, such as ${joinValues(REASONING_LEVELS)}.`,
  );
}

export function prependErrorContext(context: string, err: unknown): Error {
  return new Error(`${context}: ${getErrorMessage(err)}`);
}

export function joinValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(" or ");
}
