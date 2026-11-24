import type { CommandRun, PathFacts } from "./contract.js";

const TARGET_MAX = 400;

const MATCH_TEXT_MAX = 200;

const RESULT_MAX = 2000;

const HOST_ID = /^[A-Za-z0-9_-]{1,64}$/;

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

const COMMAND_NOT_RUNNABLE = new Map([
  [126, "the command is not executable (exit 126)"],
  [127, "the command was not found (exit 127)"],
]);

export interface HttpTarget {
  url: URL;
  text: string | null;
}

export interface HostTarget {
  hostId: string;
  value: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function failed<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function hasLineBreak(text: string): boolean {
  return /[\r\n]/.test(text);
}

export function parseHttpTarget(target: string): Parsed<HttpTarget> {
  if (target.length > TARGET_MAX || hasLineBreak(target))
    return failed(`expected one line of at most ${TARGET_MAX} characters`);

  const hash = target.indexOf("#");
  const address = hash === -1 ? target : target.slice(0, hash);
  const text = hash === -1 ? null : target.slice(hash + 1);

  if (text !== null && (text === "" || text.length > MATCH_TEXT_MAX))
    return failed(`the text after # must be 1 to ${MATCH_TEXT_MAX} characters`);

  if (!URL.canParse(address)) return failed("expected an http or https URL");

  const url = new URL(address);

  if (url.protocol !== "http:" && url.protocol !== "https:")
    return failed("expected an http or https URL");

  if (url.username !== "" || url.password !== "")
    return failed("keep credentials out of the URL");

  return { ok: true, value: { url, text } };
}

export function parseHostTarget(
  target: string,
  what: string,
): Parsed<HostTarget> {
  if (target.length > TARGET_MAX || hasLineBreak(target))
    return failed(`expected one line of at most ${TARGET_MAX} characters`);

  const colon = target.indexOf(":");
  const hostId = colon === -1 ? "" : target.slice(0, colon);
  const value = colon === -1 ? "" : target.slice(colon + 1);

  if (!HOST_ID.test(hostId)) return failed(`expected <hostId>:<${what}>`);

  if (value.trim() === "") return failed(`expected <hostId>:<${what}>`);

  return { ok: true, value: { hostId, value } };
}

export function parseFileTarget(target: string): Parsed<HostTarget> {
  const parsed = parseHostTarget(target, "path");

  if (!parsed.ok) return parsed;

  return parsed.value.value.startsWith("/") ||
    WINDOWS_ABSOLUTE.test(parsed.value.value)
    ? parsed
    : failed("the path must be absolute");
}

export function describeHttp(target: HttpTarget): string {
  const where = `${target.url.host}${target.url.pathname === "/" ? "" : target.url.pathname}`;

  return target.text === null
    ? `${where} answers`
    : `${where} shows "${target.text}"`;
}

export function httpResult(
  target: HttpTarget,
  status: number,
  body: string,
): string | null {
  if (status < 200 || status > 299) return null;

  if (target.text !== null && !body.includes(target.text)) return null;

  return target.text === null
    ? `${target.url.href} answered ${status}.`
    : `${target.url.href} answered ${status} and contains "${target.text}".`;
}

export function fileResult(
  target: HostTarget,
  facts: PathFacts,
): string | null {
  if (!facts.exists) return null;

  const detail = [
    facts.kind ?? "other",
    ...(facts.size === null || facts.kind !== "file"
      ? []
      : [`${facts.size} bytes`]),
    ...(facts.modifiedAt === null
      ? []
      : [`modified ${new Date(facts.modifiedAt).toISOString()}`]),
  ];

  return `${target.value} exists on ${target.hostId} (${detail.join(", ")}).`;
}

export type CommandOutcome =
  | { kind: "fired"; result: string }
  | { kind: "problem"; problem: string }
  | { kind: "waiting" };

export function commandOutcome(
  target: HostTarget,
  run: CommandRun,
): CommandOutcome {
  if (run.timedOut)
    return { kind: "problem", problem: "the command timed out" };

  const unrunnable =
    run.exitCode === null ? undefined : COMMAND_NOT_RUNNABLE.get(run.exitCode);

  if (unrunnable !== undefined) return { kind: "problem", problem: unrunnable };

  if (run.exitCode !== 0) return { kind: "waiting" };

  const output = run.stdout.trim();
  const head = `\`${target.value}\` succeeded on ${target.hostId}.`;

  return {
    kind: "fired",
    result: clip(output === "" ? head : `${head}\n${output}`, RESULT_MAX),
  };
}
