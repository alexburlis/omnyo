import { describe, expect, it } from "vitest";
import { classifyShellCommandPhase } from "./timeline-work-lane";

describe("timeline work lane", () => {
  it.each([
    ["rg timeline apps/app", "investigate"],
    ["git status --short", "investigate"],
    ["sed -n '1,80p' src/app.ts", "investigate"],
    ["sqlite3 data.db 'select 1'", "investigate"],
    ["pnpm --filter @omnyo/app build", "build"],
    ["pnpm exec turbo run build --filter=@omnyo/app", "build"],
    ["pnpm private:web --prepare", "build"],
    ["pnpm install", "build"],
    ["pnpm test", "test"],
    ["pnpm exec turbo run typecheck --filter=@omnyo/app", "test"],
    ["cd app && pnpm exec vitest run test.ts | tail -20", "test"],
    ["CI=1 rtk proxy pnpm lint", "test"],
    ["timeout 30 cargo test", "test"],
    ["python3 -m pytest", "test"],
    ["xcodebuild -scheme App test", "test"],
    ["pnpm exec oxfmt --check src", "test"],
    ["git add app.ts && git commit -m fix && git push", "ship"],
    ["pnpm private:web", "ship"],
    ["pnpm private:ship --version 1.2.3", "ship"],
    ["omnyo updates web apply --directory dist", "ship"],
    ["omnyo plugin reload glance", "ship"],
    ["bb plugin reload glance", "ship"],
    ["gh pr create --title fix", "ship"],
    ["/Users/developer/bin/coolify-api applications", "ship"],
    ["echo done", null],
    ["node scripts/job.mjs", null],
    ["sleep 10", null],
  ] as const)("classifies %s as %s", (command, phase) => {
    expect(classifyShellCommandPhase(command)).toBe(phase);
  });
});
