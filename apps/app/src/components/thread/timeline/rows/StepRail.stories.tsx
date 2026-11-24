import type { TimelineRow, TimelineRowStatus } from "@omnyo/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import {
  commandRow,
  conversationRow,
  fileReadRow,
} from "@/test/fixtures/thread-timeline-rows";

export default {
  title: "thread/timeline/rows/Step Rail",
};

const T = "thr_preview";

const TURN = "turn_preview";

const BASE = Date.now() - 600_000;

function msg(
  seq: number,
  text: string,
  role: "user" | "assistant" = "assistant",
): TimelineRow {
  return conversationRow({
    id: `${T}:${role}:${seq}`,
    threadId: T,
    turnId: TURN,
    role,
    sourceSeqStart: seq,
    startedAt: BASE + seq * 1000,
    createdAt: BASE + seq * 1000,
    text,
  });
}

function cmd(
  seq: number,
  command: string,
  durationMs: number,
  status: TimelineRowStatus = "completed",
  exitCode: number | null = 0,
): TimelineRow {
  const startedAt =
    status === "pending" ? Date.now() - 3000 : BASE + seq * 1000;

  return commandRow({
    id: `${T}:command:${seq}`,
    threadId: T,
    turnId: TURN,
    sourceSeqStart: seq,
    startedAt,
    createdAt: startedAt,
    status,
    command,
    exitCode,
    durationMs,
    output: "ok",
  });
}

function read(seq: number, path: string): TimelineRow {
  return fileReadRow({
    id: `${T}:file-read:${seq}`,
    threadId: T,
    turnId: TURN,
    sourceSeqStart: seq,
    startedAt: BASE + seq * 1000,
    createdAt: BASE + seq * 1000,
    status: "completed",
    callId: `read_${seq}`,
    durationMs: 50,
    path,
  });
}

const rows: TimelineRow[] = [
  msg(1, "Lock her tailnet down to the exit node and Pi-hole.", "user"),
  msg(
    2,
    "Updating the tailnet policy so she only reaches the exit node and Pi-hole.",
  ),
  cmd(3, "tailscale-api acl get", 6000),
  cmd(4, "tailscale-api acl validate policy.hujson", 7000),
  cmd(5, "tailscale-api acl set policy.hujson", 7000),
  msg(6, "Saved. Now verifying it stuck and testing both sides."),
  cmd(7, "tailscale-api acl get | diff - policy.hujson", 3400),
  cmd(8, "tailscale ping her-mac", 3500),
  msg(
    9,
    "Policy is live (Tailscale reformatted it). Reading her Mac's test result.",
  ),
  cmd(10, "omnyo file read --host her-mac /tmp/acl-test.txt", 23000),
  msg(
    11,
    "Your access is unchanged and she's locked out of your servers. Now checking whether her DNS goes through Pi-hole (the remaining gap).",
  ),
  cmd(12, "dig @100.64.0.53 doubleclick.net", 12000, "completed", 1),
  cmd(13, "ssh pi tail -n 50 /var/log/pihole.log", 8000),
  msg(
    14,
    "Her DNS also goes through Pi-hole now (probe query seen in Pi-hole's log; ad domain blocked). Updating the runbook entry with the corrected setup.",
  ),
  read(15, "docs/runbooks/tailnet.md"),
  msg(16, "Closing the browser session and the check terminals."),
  cmd(
    17,
    "omnyo browser-automation close 5c638f79-af4b-439c-90ab-3905d8acaf9b --json 2>&1 | head -c 200",
    3000,
    "pending",
    null,
  ),
];

export function LiveTurn() {
  return (
    <div className="@container/page mx-auto w-full max-w-[720px] p-6">
      <ThreadTimelineRows
        threadRuntimeDisplayStatus="active"
        workspaceRootPath={undefined}
        timelineRows={rows}
      />
    </div>
  );
}
