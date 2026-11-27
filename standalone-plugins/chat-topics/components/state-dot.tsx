import { familyStopping, rootAttention, type ChatNode, type ChatState } from "../lib/grouping.ts";

export type DotKind = "need" | "failed" | "blk" | "run" | "stop" | "que" | "ext" | "done" | "idle";

export const DOT_OF_STATE: Readonly<Record<ChatState, DotKind>> = {
  need: "need",
  failed: "failed",
  blk: "blk",
  run: "run",
  que: "que",
  ext: "ext",
  done: "done",
  idle: "idle",
};

export const DOT_LABEL: Readonly<Record<DotKind, string>> = {
  need: "Needs you",
  failed: "Failed",
  blk: "Blocked",
  run: "Working",
  stop: "Stopping",
  que: "Waiting",
  ext: "External",
  done: "Ready to archive",
  idle: "Open",
};

export function nodeDot(node: Pick<ChatNode, "state" | "family">): DotKind {
  return familyStopping(node) ? "stop" : DOT_OF_STATE[node.state];
}

export function rootDot(node: ChatNode): DotKind {
  return rootAttention(node).asking ? "need" : nodeDot(node);
}

interface StateDotProps {
  kind: DotKind;
  label: string | null;
  agents?: number;
}

export function StateDot({ kind, label, agents = 0 }: StateDotProps) {
  const counted = kind === "run" && agents > 0;

  const named =
    label !== null && counted
      ? `${label} · ${agents} ${agents === 1 ? "subchat or subagent" : "subchats and subagents"}`
      : label;

  return (
    <span
      className="ct-dot"
      data-dot={kind}
      data-agents={counted ? agents : undefined}
      role={named === null ? undefined : "img"}
      aria-hidden={named === null ? true : undefined}
      aria-label={named ?? undefined}
      title={named ?? undefined}
    >
      <svg className="ct-dot-ring" viewBox="0 0 10 10" aria-hidden>
        <circle className="ct-dot-track" cx="5" cy="5" r="4.2" />
        <path d="M5 .8A4.2 4.2 0 0 1 9.2 5" />
      </svg>
      <svg className="ct-dot-check" viewBox="0 0 10 10" aria-hidden>
        <path
          d="M2 5.2 4.1 7.2 8 3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {counted ? (
        <span className="ct-dot-count" data-wide={agents > 9} aria-hidden>
          {agents}
        </span>
      ) : null}
    </span>
  );
}
