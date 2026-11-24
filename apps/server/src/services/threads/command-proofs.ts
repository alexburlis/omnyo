import { listRecentCompletedCommandHeaders, type DbConnection } from "@omnyo/db";
import {
  COMMAND_PROOF_EVENT_WINDOW,
  type CommandExecutionProof,
  type CommandProofLookupRequest,
  type CommandProofLookupResponse,
  type CommandProofLookupResult,
} from "@omnyo/server-contract";
import { requirePublicThread } from "../lib/entity-lookup.js";
import { listThreadEventRows } from "./thread-data.js";
import { redactThreadHistory } from "./thread-history-redaction.js";

function normalize(command: string): string {
  return command.trim().replace(/\r\n/gu, "\n");
}

export function lookupCommandProofs(
  db: DbConnection,
  threadId: string,
  input: CommandProofLookupRequest,
): CommandProofLookupResponse {
  requirePublicThread(db, threadId);

  if (input.selectors.length === 0) return { threadId, proofs: [] };

  const matches = new Map<string, number[]>();

  for (const selector of input.selectors)
    if (selector.kind === "command")
      matches.set(normalize(selector.command), []);

  if (matches.size > 0) {
    const headers = redactThreadHistory(
      db,
      threadId,
      listRecentCompletedCommandHeaders(db, {
        threadId,
        completedEventLimit: COMMAND_PROOF_EVENT_WINDOW,
      }),
      { invalidJsonText: "withhold" },
    );

    for (const header of headers) {
      const selected = matches.get(normalize(header.command));

      if (selected !== undefined && selected.length < 2)
        selected.push(header.sequence);
    }
  }

  const executions = new Map<number, CommandExecutionProof | null>();

  const execution = (eventSeq: number): CommandExecutionProof | null => {
    if (executions.has(eventSeq)) return executions.get(eventSeq) ?? null;

    const rows = redactThreadHistory(
      db,
      threadId,
      listThreadEventRows(db, {
        threadId,
        afterSeq: eventSeq - 1,
        beforeSeq: eventSeq + 1,
        limit: 1,
        types: ["item/completed"],
      }),
      { invalidJsonText: "withhold" },
    );

    const row = rows[0];

    if (
      !row ||
      row.seq !== eventSeq ||
      row.type !== "item/completed" ||
      row.data.item.type !== "commandExecution"
    ) {
      executions.set(eventSeq, null);

      return null;
    }

    const item = row.data.item;
    const output = item.aggregatedOutput ?? "";

    const proof: CommandExecutionProof = {
      eventSeq: row.seq,
      command: item.command.slice(0, 500),
      cwd: item.cwd.slice(0, 1000),
      status: item.status,
      exitCode: item.exitCode ?? null,
      excerpt:
        output.length <= 3000
          ? output
          : `${output.slice(0, 1499)}\n…\n${output.slice(-1498)}`,
    };

    executions.set(eventSeq, proof);

    return proof;
  };

  const proofs = input.selectors.map((selector): CommandProofLookupResult => {
    const candidates =
      selector.kind === "event"
        ? [selector.eventSeq]
        : (matches.get(normalize(selector.command)) ?? []);

    if (candidates.length > 1) return { status: "ambiguous" };
    const eventSeq = candidates[0];
    const found = eventSeq === undefined ? null : execution(eventSeq);

    return found === null
      ? { status: "missing" }
      : { status: "matched", execution: found };
  });

  return { threadId, proofs };
}
