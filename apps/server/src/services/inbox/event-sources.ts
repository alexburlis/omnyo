import { hosts, type DbQueryConnection } from "@omnyo/db";
import {
  INBOX_FOR_TEXT_MAX,
  splitEventKey,
  type InboxEventSourceView,
} from "@omnyo/domain";
import { eq } from "drizzle-orm";
import semverCoerce from "semver/functions/coerce.js";
import semverValid from "semver/functions/valid.js";
import { ApiError } from "../../errors.js";
import {
  listPluginEventSources,
  type PluginEventSourceRecord,
} from "../plugins/plugin-event-source-registry.js";

export type EventSourceOutcome =
  | { target: string; result: string }
  | { target: string; problem: string };

export interface EventSource {
  family: string;
  owner: { kind: "core" } | { kind: "plugin"; record: PluginEventSourceRecord };
  label: string;
  keyFormat: string;
  examples: readonly string[];
  approval: "none" | "owner";
  validate(target: string, db: DbQueryConnection): string | null;
  describe(target: string): string;
  poll: {
    everyMs: number;
    check(
      targets: readonly string[],
      context: { signal: AbortSignal },
    ): Promise<readonly EventSourceOutcome[]>;
  } | null;
  proof: ((context: { signal: AbortSignal }) => Promise<string>) | null;
}

export interface EventSourceHealth {
  lastCheckAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextPollAt: number;
  proof: { ok: boolean; detail: string } | null;
  targetProblems: Map<string, { count: number; problem: string }>;
}

const CORE_SOURCES: readonly EventSource[] = [
  {
    family: "host-reconnect",
    owner: { kind: "core" },
    label: "A machine reconnects to Omnyo",
    keyFormat: "host-reconnect:<hostId>",
    examples: ["host-reconnect:host_j3eq7xguuw"],
    approval: "none",
    validate: (target, db) =>
      target !== "" &&
      db
        .select({ id: hosts.id })
        .from(hosts)
        .where(eq(hosts.id, target))
        .get() !== undefined
        ? null
        : `Unknown host ${target === "" ? "(empty)" : target}`,
    describe: (target) => `Machine ${target} reconnects`,
    poll: null,
    proof: null,
  },
  {
    family: "coordinator-version",
    owner: { kind: "core" },
    label: "The Omnyo coordinator runs at least a version",
    keyFormat: "coordinator-version:<version>",
    examples: ["coordinator-version:0.47.0"],
    approval: "none",
    validate: (target) =>
      semverValid(semverCoerce(target)) === null
        ? `Not a version: ${target}`
        : null,
    describe: (target) => `Omnyo ${target} is running`,
    poll: null,
    proof: null,
  },
  {
    family: "automation-run",
    owner: { kind: "core" },
    label: "An automation that re-prompts this chat runs again",
    keyFormat: "automation-run:<automationId>",
    examples: ["automation-run:auto_4pwqxipk_i8"],
    approval: "none",
    validate: (target) => (target === "" ? "No automation" : null),
    describe: (target) => `Automation ${target} runs`,
    poll: null,
    proof: null,
  },
];

const health = new Map<string, EventSourceHealth>();

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function listEventSources(): EventSource[] {
  return [
    ...CORE_SOURCES,
    ...listPluginEventSources().map((record) => {
      const { source } = record;

      return {
        family: source.family,
        owner: { kind: "plugin" as const, record },
        label: source.label,
        keyFormat: source.keyFormat,
        examples: source.examples,
        approval: source.approval,
        validate: (target: string) => {
          try {
            return source.validate(target);
          } catch (error) {
            return `The ${source.family} source could not read this key: ${failureText(error)}`;
          }
        },
        describe: (target: string) => {
          try {
            return clip(source.describe(target), INBOX_FOR_TEXT_MAX);
          } catch {
            return clip(`${source.family}:${target}`, INBOX_FOR_TEXT_MAX);
          }
        },
        poll: source.poll,
        proof: source.proof,
      };
    }),
  ];
}

export function findEventSource(
  key: string,
): { source: EventSource; target: string } | null {
  const parts = splitEventKey(key);

  if (parts === null) return null;

  const source = listEventSources().find(
    (item) => item.family === parts.family,
  );

  return source === undefined ? null : { source, target: parts.target };
}

export function eventKeyProblem(
  db: DbQueryConnection,
  key: string,
): string | null {
  const shape = eventKeyShapeProblem(db, key);

  if (shape !== null) return shape;

  const state = health.get(findEventSource(key)?.source.family ?? "");

  if (state?.proof !== undefined && state.proof !== null && !state.proof.ok)
    return `The ${splitEventKey(key)?.family ?? key} source cannot check keys: ${state.proof.detail}. Fix that, then run omnyo wait check ${key} to test it again.`;

  return null;
}

export function eventKeyShapeProblem(
  db: DbQueryConnection,
  key: string,
): string | null {
  const parts = splitEventKey(key);

  if (parts === null)
    return `"${key}" is not an event key. Keys look like <family>:<target>; omnyo wait sources lists them.`;

  const found = findEventSource(key);

  if (found === null)
    return `No installed event source handles "${parts.family}" keys. Installed: ${listEventSources()
      .map((source) => source.family)
      .join(", ")}. omnyo wait sources shows their formats.`;

  const { source, target } = found;
  const problem = source.validate(target, db);

  if (problem !== null)
    return `${key}: ${problem}. Format: ${source.keyFormat}, for example ${source.examples[0] ?? source.keyFormat}.`;

  return null;
}

export function validateEventKey(db: DbQueryConnection, key: string): void {
  const problem = eventKeyProblem(db, key);

  if (problem !== null) throw new ApiError(400, "invalid_request", problem);
}

export function describeEventKey(key: string): string {
  const found = findEventSource(key);

  return found === null ? key : found.source.describe(found.target);
}

export function eventKeyNeedsApproval(key: string): boolean {
  return findEventSource(key)?.source.approval === "owner";
}

export function requireEventReporter(pluginId: string, key: string): void {
  const owner = findEventSource(key)?.source.owner;

  if (
    owner === undefined ||
    owner.kind !== "plugin" ||
    owner.record.pluginId !== pluginId
  )
    throw new ApiError(
      403,
      "event_reporter_required",
      `Only the plugin that observes ${key} can report it.`,
    );
}

export function eventSourceHealth(family: string): EventSourceHealth {
  const existing = health.get(family);

  if (existing !== undefined) return existing;

  const created: EventSourceHealth = {
    lastCheckAt: null,
    lastOkAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextPollAt: 0,
    proof: null,
    targetProblems: new Map(),
  };

  health.set(family, created);

  return created;
}

export function resetEventSourceHealth(): void {
  health.clear();
}

export function eventSourceView(
  source: EventSource,
  pendingKeys: number,
): InboxEventSourceView {
  const state = health.get(source.family);

  const proofFailed =
    state?.proof !== undefined && state.proof !== null && !state.proof.ok;

  return {
    family: source.family,
    owner: source.owner.kind === "core" ? "core" : source.owner.record.pluginId,
    label: source.label,
    keyFormat: source.keyFormat,
    examples: [...source.examples],
    approval: source.approval,
    kind: source.poll === null ? "push" : "poll",
    everyMs: source.poll?.everyMs ?? null,
    pendingKeys,
    health: {
      state:
        state === undefined || state.lastCheckAt === null
          ? proofFailed
            ? "proof-failed"
            : "idle"
          : proofFailed
            ? "proof-failed"
            : state.consecutiveFailures > 0
              ? "failing"
              : "ok",
      lastCheckAt: state?.lastCheckAt ?? null,
      lastOkAt: state?.lastOkAt ?? null,
      lastError: state?.lastError ?? null,
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      proof: state?.proof?.detail ?? null,
    },
  };
}
