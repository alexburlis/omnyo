import { useState } from "react";
import { TerminalOutputBlock } from "../TerminalOutputBlock";
import type { TimelineRow } from "@omnyo/server-contract";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import { commandRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Command",
};

function TimelineStage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const baseProps = {
  threadRuntimeDisplayStatus: "idle" as const,
  workspaceRootPath: undefined,
};

const lintCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_sad2tEhg7JbBkt36PDVPgAbL",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 36144,
  sourceSeqEnd: 36149,
  startedAt: 1777337400300,
  createdAt: 1777337400998,
  status: "completed",
  callId: "call_sad2tEhg7JbBkt36PDVPgAbL",
  command:
    "pnpm exec turbo run lint --filter=@omnyo/core-ui --filter=@omnyo/server --concurrency=1",
  cwd: "/Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo",
  source: null,
  output:
    "• turbo 2.8.3\n• Packages in scope: @omnyo/core-ui, @omnyo/server\n• Running lint in 2 packages\n• Remote caching disabled, using shared worktree cache\n\nNo tasks were executed as part of this run.\n\n Tasks:    0 successful, 0 total\nCached:    0 cached, 0 total\n  Time:    90ms \n\n",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 698,
});

const buildCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_bdPhraVkSWcMs5kt1qRviLwZ",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 36459,
  sourceSeqEnd: 36521,
  startedAt: 1777337519841,
  createdAt: 1777337521831,
  status: "completed",
  callId: "call_bdPhraVkSWcMs5kt1qRviLwZ",
  command: "pnpm exec turbo run build --filter=@omnyo/server --concurrency=1",
  cwd: "/Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo",
  source: null,
  output:
    "\u2022 turbo 2.8.3\n\u2022 Packages in scope: @omnyo/server\n\u2022 Running build in 1 packages\n\u2022 Remote caching disabled, using shared worktree cache\n@omnyo/process-utils:build: cache hit, replaying logs 9de11a586fe39bfe\n@omnyo/process-utils:build: \n@omnyo/process-utils:build: > @omnyo/process-utils@0.0.1 build /Users/michael/.codex/worktrees/d914/omnyo/packages/process-utils\n@omnyo/process-utils:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@omnyo/process-utils:build: \n@omnyo/domain:build: cache hit, replaying logs 103774c8ba3d56bc\n@omnyo/domain:build: \n@omnyo/domain:build: > @omnyo/domain@0.0.1 build /Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo/packages/domain\n@omnyo/domain:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@omnyo/domain:build: \n@omnyo/server-contract:build: cache hit, replaying logs ce1ed8341c645fb1\n@omnyo/server-contract:build: \n@omnyo/server-contract:build: > @omnyo/server-contract@0.0.1 build /Users/michael/.codex/worktrees/d914/omnyo/packages/server-contract\n@omnyo/server-contract:build: > tsc\n@omnyo/server-contract:build: \n@omnyo/templates:build: cache hit, replaying logs 5f5da67cbdf705f2\n@omnyo/templates:build: \n@omnyo/templates:build: > @omnyo/templates@0.0.1 build /Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo/packages/templates\n@omnyo/templates:build: > node ./scripts/generate-templates.mjs && esbuild src/index.ts --bundle --platform=node --target=node20 --format=esm --outfile=dist/index.js --sourcemap && tsc --project tsconfig.json --emitDeclarationOnly --declaration --declarationMap --outDir dist\n@omnyo/templates:build: \n@omnyo/templates:build: \n@omnyo/templates:build:   dist/index.js      270.5kb\n@omnyo/templates:build:   dist/index.js.map  439.4kb\n@omnyo/templates:build: \n@omnyo/templates:build: \u26a1 Done in 10ms\n@omnyo/secret-storage:build: cache hit, replaying logs 8b137f6300ba5864\n@omnyo/secret-storage:build: \n@omnyo/secret-storage:build: > @omnyo/secret-storage@0.0.1 build /Users/michael/.codex/worktrees/d914/omnyo/packages/secret-storage\n@omnyo/secret-storage:build: > rm -rf dist tsconfig.tsbuildinfo && tsc\n@omnyo/secret-storage:build: \n@omnyo/hono-typed-routes:build: cache hit, replaying logs 9c8ab6ce7d3ea2eb\n@omnyo/hono-typed-routes:build: \n@omnyo/hono-typed-routes:build: > @omnyo/hono-typed-routes@0.0.1 build /Users/michael/.codex/worktrees/d914/omnyo/packages/hono-typed-routes\n@omnyo/hono-typed-routes:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@omnyo/hono-typed-routes:build: \n@omnyo/config:build: cache hit, replaying logs 0ef37fe60164e4b6\n@omnyo/config:build: \n@omnyo/config:build: > @omnyo/config@0.0.1 build /Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo/packages/config\n@omnyo/config:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@omnyo/config:build: \n@omnyo/test-helpers:build: cache hit, replaying logs dc291cedace4ce6c\n@omnyo/test-helpers:build: \n@omnyo/test-helpers:build: > @omnyo/test-helpers@0.0.1 build /Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo/packages/test-helpers\n@omnyo/test-helpers:build: > rimraf dist tsconfig.tsbuildinfo && tsc\n@omnyo/test-helpers:build: \n@omnyo/db:build: cache hit, replaying logs 2e667adc5220280f\n@omnyo/db:build: \n@omnyo/db:build: > @omnyo/db@0.0.1 build /Users\n... [truncated for fixture]",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 1990,
});

const failedTestCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_YP1N5ZE2JWN5lUQhSCRbDiqU",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 36242,
  sourceSeqEnd: 36392,
  startedAt: 1777337478063,
  createdAt: 1777337485182,
  status: "error",
  callId: "call_YP1N5ZE2JWN5lUQhSCRbDiqU",
  command:
    "pnpm exec turbo run test --filter=@omnyo/core-ui --filter=@omnyo/server --only --concurrency=1",
  cwd: "/Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo",
  source: null,
  output:
    "\u2022 turbo 2.8.3\n\u2022 Packages in scope: @omnyo/core-ui, @omnyo/server\n\u2022 Running test in 2 packages\n\u2022 Remote caching disabled, using shared worktree cache\n@omnyo/server:test: cache miss, executing 38ec9ac79a329473\n@omnyo/server:test: \n@omnyo/server:test: > @omnyo/server@0.0.1 test /Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo/apps/server\n@omnyo/server:test: > vitest run --config vitest.config.ts\n@omnyo/server:test: \n@omnyo/server:test: \n@omnyo/server:test: \u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv4.1.1 \u001b[39m\u001b[90m/Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo/apps/server\u001b[39m\n@omnyo/server:test: \n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/public/public-thread-interactions.test.ts \u001b[2m(\u001b[22m\u001b[2m11 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 347\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/public/public-thread-data.test.ts \u001b[2m(\u001b[22m\u001b[2m11 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 328\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/public/public-thread-lifecycle-regressions.test.ts \u001b[2m(\u001b[22m\u001b[2m12 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 373\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/host-join-enroll.test.ts \u001b[2m(\u001b[22m\u001b[2m16 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 451\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/internal/internal-command-result-idempotency.test.ts \u001b[2m(\u001b[22m\u001b[2m16 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 451\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/internal/internal-event-side-effects.test.ts \u001b[2m(\u001b[22m\u001b[2m16 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 508\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/services/pending-interactions.test.ts \u001b[2m(\u001b[22m\u001b[2m22 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 595\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/public/public-thread-lifecycle-regressions.test.ts \u001b[2m(\u001b[22m\u001b[2m12 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 580\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/services/pending-interactions.test.ts \u001b[2m(\u001b[22m\u001b[2m15 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 510\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/public/public-projects-hosts.test.ts \u001b[2m(\u001b[22m\u001b[2m23 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 654\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/public/public-threads.environments.test.ts \u001b[2m(\u001b[22m\u001b[2m21 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 653\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/public/public-environments-system.test.ts \u001b[2m(\u001b[22m\u001b[2m24 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 814\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/internal/internal-session-correctness.test.ts \u001b[2m(\u001b[22m\u001b[2m33 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 968\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\u001b[39m test/public/public-thread-data.test.ts \u001b[2m(\u001b[22m\u001b[2m27 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 979\u001b[2mms\u001b[22m\u001b[39m\n@omnyo/server:test:  \u001b[32m\u2713\u001b[39m \u001b[30m\u001b[45m @omnyo/server \u001b[49m\n... [truncated for fixture]",
  exitCode: 1,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 7119,
});

const interruptedCommand: TimelineRow = commandRow({
  id: "thr_gnkq5q3vnt:command:call_ladle_interrupted",
  threadId: "thr_gnkq5q3vnt",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 0,
  sourceSeqEnd: 0,
  startedAt: 1777337000000,
  createdAt: 1777337000000,
  status: "interrupted",
  callId: "call_ladle_interrupted",
  command: "pnpm --filter @omnyo/app ladle -- --host 127.0.0.1 --port 6167",
  cwd: "/Users/michael/.omnyo-dev/worktrees/env_ec5gx8y7mm/omnyo",
  source: null,
  output:
    '   ╭────────────────────────────────────────────────────╮\n   │                                                    │\n   │   🥄 Ladle.dev served at http://localhost:61000/   │\n   │                                                    │\n   ╰────────────────────────────────────────────────────╯\n\n8:12:55 PM [vite] (client) ✨ new dependencies optimized: axe-core, msw/browser\n8:12:55 PM [vite] (client) ✨ optimized dependencies changed. reloading\n\n  Error: read ECONNRESET\n      at TCP.onStreamRead (node:internal/stream_base_commons:216:20)\n\n/Users/michael/.omnyo-dev/worktrees/env_ec5gx8y7mm/omnyo/apps/app:\n ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @omnyo/app@0.0.1 ladle: `ladle serve "--" "--host" "127.0.0.1" "--port" "6167"`\nCommand failed with signal "SIGTERM"\n',
  exitCode: -1,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 10000,
});

const runningCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_running",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 36500,
  sourceSeqEnd: 36500,
  startedAt: Date.now(),
  createdAt: Date.now(),
  status: "pending",
  callId: "call_running",
  command: "pnpm exec turbo run test --filter=@omnyo/server",
  cwd: "/Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo",
  source: null,
  output: "",
  exitCode: null,
  approvalStatus: null,
  activityIntents: [],
  durationMs: null,
});

const waitingApprovalCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_waiting_approval",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 36600,
  sourceSeqEnd: 36600,
  startedAt: 1777337700000,
  createdAt: 1777337700000,
  status: "pending",
  callId: "call_waiting_approval",
  command: "git push --force-with-lease origin main",
  cwd: "/Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo",
  source: null,
  output: "",
  exitCode: null,
  approvalStatus: "waiting_for_approval",
  activityIntents: [],
  durationMs: null,
});

const gitStatusCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_mGiBdXdFLpyTGMucYCnI82LR",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 35830,
  sourceSeqEnd: 35831,
  startedAt: 1777337321939,
  createdAt: 1777337321939,
  status: "completed",
  callId: "call_mGiBdXdFLpyTGMucYCnI82LR",
  command: "git status --short",
  cwd: "/Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo",
  source: null,
  output:
    " M apps/server/src/services/threads/timeline.ts\n D packages/core-ui/src/active-thinking.ts\n M packages/core-ui/src/assistant-stream-projection.ts\n M packages/core-ui/src/index.ts\n M packages/core-ui/src/to-view-messages.ts\n",
  exitCode: 0,
  approvalStatus: null,
  activityIntents: [],
  durationMs: 0,
});

const deniedCommand: TimelineRow = commandRow({
  id: "thr_zeb7z9afmw:command:call_denied",
  threadId: "thr_zeb7z9afmw",
  turnId: "019dd185-ef12-7d50-aa48-47882e9c8aaf",
  sourceSeqStart: 36700,
  sourceSeqEnd: 36700,
  startedAt: 1777337800000,
  createdAt: 1777337800000,
  status: "completed",
  callId: "call_denied",
  command: "rm -rf node_modules",
  cwd: "/Users/michael/.omnyo-dev/worktrees/env_33i22gvcqe/omnyo",
  source: null,
  output: "",
  exitCode: null,
  approvalStatus: "denied",
  activityIntents: [],
  durationMs: 5000,
});

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="collapsed — completed"
        hint="production-default — header only, click to expand"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[buildCommand]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — running"
        hint="status=pending, no exit code yet, output streaming"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[runningCommand]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow label="collapsed — error" hint="status=error, exit 1">
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[failedTestCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — interrupted"
        hint="killed by controlling timeout (SIGTERM, exit -1)"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[interruptedCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — waiting for approval"
        hint="approvalStatus=waiting_for_approval, queued before execution"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            timelineRows={[waitingApprovalCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="collapsed — denied"
        hint="approvalStatus=denied, user rejected the approval request"
      >
        <TimelineStage>
          <ThreadTimelineRows {...baseProps} timelineRows={[deniedCommand]} />
        </TimelineStage>
      </StoryRow>
      <StoryRow label="git status" hint="short clean output, exit 0">
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([gitStatusCommand.id])}
            timelineRows={[gitStatusCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="lint"
        hint="pnpm exec turbo run lint — short output, completed"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([lintCommand.id])}
            timelineRows={[lintCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="build"
        hint="pnpm exec turbo run build — longer output scrolls inside the row"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([buildCommand.id])}
            timelineRows={[buildCommand]}
          />
        </TimelineStage>
      </StoryRow>
      <StoryRow
        label="failed test"
        hint="pnpm exec turbo run test — status=error, exit 1, real failure output"
      >
        <TimelineStage>
          <ThreadTimelineRows
            {...baseProps}
            initialExpanded={new Set([failedTestCommand.id])}
            timelineRows={[failedTestCommand]}
          />
        </TimelineStage>
      </StoryRow>
    </StoryCard>
  );
}

export function Highlighted() {
  const [running, setRunning] = useState(true);

  const commandLine =
    "$ python3 - <<'PY'\nfrom pathlib import Path\nimport json\n\nfor path in Path('reports').glob('*.json'):\n    report = json.loads(path.read_text())\n    print(report['status'])\nPY";

  return (
    <div className="mx-auto w-full max-w-[760px] space-y-4 p-4">
      <button
        type="button"
        className="rounded-md border border-border px-3 py-1 text-sm"
        onClick={() => setRunning(!running)}
      >
        {running ? "Complete command" : "Run again"}
      </button>
      <TerminalOutputBlock
        commandLine={commandLine}
        exitCode={running ? null : 0}
        metadataLines={[]}
        output={
          running
            ? "Reading reports…\n3 reports checked"
            : "3 reports checked\nAll reports passed"
        }
        streaming={running}
      />
      <TerminalOutputBlock
        commandLine="$ omnyo status --json"
        exitCode={0}
        metadataLines={[]}
        output={
          '{\n  "project": "Example",\n  "status": "ready",\n  "commands": 3,\n  "errors": 0\n}'
        }
        streaming={false}
      />
    </div>
  );
}

export function LongCommand() {
  const commandLine = [
    "$ node - <<'JS'",
    "import { readdir, readFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "",
    "const root = 'reports';",
    "const files = await readdir(root);",
    "const failures = [];",
    "",
    "for (const file of files) {",
    "  if (!file.endsWith('.json')) continue;",
    "  const report = JSON.parse(await readFile(join(root, file), 'utf8'));",
    "  if (report.status !== 'passed') failures.push(file);",
    "}",
    "",
    "console.log(`${files.length} reports checked`);",
    "console.log(failures.length === 0 ? 'All reports passed' : failures.join('\\n'));",
    "JS",
  ].join("\n");

  return (
    <div className="mx-auto w-full max-w-[760px] space-y-4 p-4">
      <TerminalOutputBlock
        commandLine={commandLine}
        exitCode={0}
        metadataLines={[]}
        output={"12 reports checked\nAll reports passed"}
        streaming={false}
      />
    </div>
  );
}
