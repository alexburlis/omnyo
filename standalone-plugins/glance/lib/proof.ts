import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import type { Card, ProofLink } from "../contract.ts";

type EventRow = Awaited<ReturnType<PluginApi["sdk"]["threads"]["events"]["list"]>>[number];

type EventInput = Parameters<PluginApi["sdk"]["threads"]["events"]["list"]>[0];

const statusSchema = z.object({ status: z.number() });

export async function listEvents(api: PluginApi, input: EventInput): Promise<EventRow[]> {
  let limit = Number(input.limit ?? 100);

  while (true) {
    try {
      return await api.sdk.threads.events.list({ ...input, limit: String(limit) });
    } catch (error) {
      const parsed = statusSchema.safeParse(error);

      if (!parsed.success || parsed.data.status !== 413 || limit === 1) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }
}

function unmatched(index: number): ProofLink {
  return {
    index,
    linked: false,
    eventSeq: null,
    command: null,
    exitCode: null,
    cwd: null,
    excerpt: null,
    status: null,
    excerptUnavailable: false,
  };
}

export async function linkProof(
  api: PluginApi,
  threadId: string,
  card: Card,
  signal?: AbortSignal,
): Promise<ProofLink[]> {
  const selected = card.proof.flatMap((entry, index) => {
    if (entry.kind !== "reproduced" || entry.command === undefined) return [];

    const selector: Parameters<
      PluginApi["sdk"]["threads"]["experimental_lookupCommandProofs"]
    >[0]["selectors"][number] =
      entry.eventSeq === undefined
        ? { kind: "command", command: entry.command }
        : { kind: "event", eventSeq: entry.eventSeq };

    return [{ index, selector }];
  });

  const result = await api.sdk.threads.experimental_lookupCommandProofs({
    threadId,
    selectors: selected.map((entry) => entry.selector),
    signal,
  });

  if (result.threadId !== threadId || result.proofs.length !== selected.length)
    throw new Error("Invalid command proof response");
  const links = card.proof.map((_entry, index) => unmatched(index));

  for (const [offset, entry] of selected.entries()) {
    const proof = result.proofs[offset];

    if (proof?.status !== "matched") continue;
    links[entry.index] = {
      index: entry.index,
      linked: true,
      ...proof.execution,
      excerptUnavailable: false,
    };
  }

  return links;
}
