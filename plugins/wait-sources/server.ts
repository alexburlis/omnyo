import type {
  PluginApi,
  PluginEventSourceFiring,
  PluginEventSourceProblem,
} from "@omnyo/plugin-sdk";
import { COMMAND_TIMEOUT_MS, waitSourcesHostContract } from "./contract.js";
import {
  commandOutcome,
  describeHttp,
  fileResult,
  httpResult,
  parseFileTarget,
  parseHostTarget,
  parseHttpTarget,
  type HostTarget,
  type Parsed,
} from "./sources.js";

const HTTP_TIMEOUT_MS = 10_000;

const HTTP_BODY_MAX = 256 * 1024;

const POLL_MS = 60_000;

const COMMAND_POLL_MS = 120_000;

const HOST_CALL_SLACK_MS = 5_000;

const CONCURRENCY = 8;

type Outcome = PluginEventSourceFiring | PluginEventSourceProblem;

type MachineState = "connected" | "disconnected" | "unknown";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404;
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

async function bounded<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];

  for (let index = 0; index < items.length; index += CONCURRENCY)
    results.push(
      ...(await Promise.all(items.slice(index, index + CONCURRENCY).map(run))),
    );

  return results;
}

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();

  if (reader === undefined) return "";

  const decoder = new TextDecoder();
  let text = "";
  let size = 0;

  while (size < max) {
    const { done, value } = await reader.read();

    if (done) break;

    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }

  await reader.cancel();

  return text;
}

function validator<T>(parse: (target: string) => Parsed<T>) {
  return (target: string) => {
    const parsed = parse(target);

    return parsed.ok ? null : parsed.error;
  };
}

export default async function plugin(api: PluginApi): Promise<void> {
  const host = api.hosts.experimental_client({
    contract: waitSourcesHostContract,
  });

  function machines(signal: AbortSignal) {
    const known = new Map<string, Promise<MachineState>>();

    return (hostId: string): Promise<MachineState> => {
      const existing = known.get(hostId);

      if (existing !== undefined) return existing;

      const state = api.sdk.hosts.get({ hostId, signal }).then(
        (machine): MachineState => machine.status,
        (error: unknown): MachineState => {
          if (isNotFound(error)) return "unknown";

          throw error;
        },
      );

      known.set(hostId, state);

      return state;
    };
  }

  async function onMachine(
    target: string,
    parsed: HostTarget,
    machineOf: (hostId: string) => Promise<MachineState>,
    run: () => Promise<Outcome | null>,
  ): Promise<Outcome | null> {
    const state = await machineOf(parsed.hostId);

    if (state === "unknown")
      return { target, problem: `no machine ${parsed.hostId}` };

    if (state === "disconnected") return null;

    return run();
  }

  async function checkHttp(
    target: string,
    signal: AbortSignal,
  ): Promise<Outcome | null> {
    const parsed = parseHttpTarget(target);

    if (!parsed.ok) return { target, problem: parsed.error };

    try {
      const response = await fetch(parsed.value.url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]),
        headers: { "user-agent": "omnyo-wait-sources" },
      });

      const body =
        parsed.value.text === null
          ? ""
          : await readCapped(response, HTTP_BODY_MAX);

      if (parsed.value.text === null) await response.body?.cancel();

      const result = httpResult(parsed.value, response.status, body);

      return result === null ? null : { target, result };
    } catch (error) {
      if (signal.aborted) throw error;

      return null;
    }
  }

  api.experimental_eventSources.register({
    family: "http",
    label: "A URL answers, optionally with some text on the page",
    keyFormat: "http:<url>[#<text>]",
    examples: [
      "http:https://example.com/health",
      "http:https://example.com/status#ready",
    ],
    approval: "owner",
    validate: validator(parseHttpTarget),
    describe: (target) => {
      const parsed = parseHttpTarget(target);

      return parsed.ok ? describeHttp(parsed.value) : target;
    },
    poll: {
      everyMs: POLL_MS,
      async check(targets, { signal }) {
        const outcomes = await bounded(targets, (target) =>
          checkHttp(target, signal),
        );

        return outcomes.filter((outcome) => outcome !== null);
      },
    },
    proof: null,
  });

  api.experimental_eventSources.register({
    family: "file",
    label: "A file or folder exists on a machine",
    keyFormat: "file:<hostId>:<absolute path>",
    examples: ["file:host_j3eq7xguuw:/tmp/build-done"],
    approval: "none",
    validate: validator(parseFileTarget),
    describe: (target) => {
      const parsed = parseFileTarget(target);

      return parsed.ok
        ? `${lastSegment(parsed.value.value)} exists on ${parsed.value.hostId}`
        : target;
    },
    poll: {
      everyMs: POLL_MS,
      async check(targets, { signal }) {
        const machineOf = machines(signal);

        const outcomes = await bounded(targets, async (target) => {
          const parsed = parseFileTarget(target);

          if (!parsed.ok) return { target, problem: parsed.error };

          return onMachine(target, parsed.value, machineOf, async () => {
            try {
              const facts = await host.call(
                "stat",
                { path: parsed.value.value },
                { hostId: parsed.value.hostId, signal, timeoutMs: 15_000 },
              );

              const result = fileResult(parsed.value, facts);

              return result === null ? null : { target, result };
            } catch (error) {
              if (signal.aborted) throw error;

              return {
                target,
                problem: `${parsed.value.hostId} could not check: ${errorMessage(error)}`,
              };
            }
          });
        });

        return outcomes.filter((outcome) => outcome !== null);
      },
    },
    proof: null,
  });

  api.experimental_eventSources.register({
    family: "command",
    label: "A shell command succeeds on a machine",
    keyFormat: "command:<hostId>:<shell command>",
    examples: ["command:host_j3eq7xguuw:test -f /tmp/build-done"],
    approval: "owner",
    validate: validator((target) => parseHostTarget(target, "command")),
    describe: (target) => {
      const parsed = parseHostTarget(target, "command");

      return parsed.ok
        ? `\`${parsed.value.value}\` succeeds on ${parsed.value.hostId}`
        : target;
    },
    poll: {
      everyMs: COMMAND_POLL_MS,
      async check(targets, { signal }) {
        const machineOf = machines(signal);

        const outcomes = await bounded(targets, async (target) => {
          const parsed = parseHostTarget(target, "command");

          if (!parsed.ok) return { target, problem: parsed.error };

          return onMachine(target, parsed.value, machineOf, async () => {
            try {
              const run = await host.call(
                "runCheck",
                { command: parsed.value.value },
                {
                  hostId: parsed.value.hostId,
                  signal,
                  timeoutMs: COMMAND_TIMEOUT_MS + HOST_CALL_SLACK_MS,
                },
              );

              const outcome = commandOutcome(parsed.value, run);

              if (outcome.kind === "fired")
                return { target, result: outcome.result };

              return outcome.kind === "problem"
                ? { target, problem: outcome.problem }
                : null;
            } catch (error) {
              if (signal.aborted) throw error;

              return {
                target,
                problem: `${parsed.value.hostId} could not run it: ${errorMessage(error)}`,
              };
            }
          });
        });

        return outcomes.filter((outcome) => outcome !== null);
      },
    },
    proof: null,
  });
}
