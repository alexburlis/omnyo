import { extractShellCommandFromString } from "@omnyo/thread-view";

export type CommandPhase = "investigate" | "build" | "test" | "ship";

const PM = String.raw`(?:pnpm|npm|yarn|bun)`;

const PM_FLAGS = String.raw`(?:(?:-r|--recursive|-w|--workspace-root|(?:--filter|-F|-C|--dir)(?:=|\s+)\S+)\s+)*`;

const RUNNER = String.raw`(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn(?:\s+dlx)?)\s+)?`;

const COMMAND_PATTERNS: readonly [CommandPhase, readonly RegExp[]][] = [
  [
    "ship",
    [
      /^git\s+(?:push|commit|tag|merge|cherry-pick)\b/u,
      /^gh\s+(?:pr\s+(?:create|merge|ready)|release\s+(?:create|upload|edit)|workflow\s+run)\b/u,
      new RegExp(
        String.raw`^${PM}\s+(?:run\s+)?private:(?:web|ship)\b(?!.*--prepare)`,
        "u",
      ),
      /^(?:omnyo|bb)\s+(?:updates\s+(?:web|app)\s+(?:apply|rollback)|plugin\s+(?:reload|install|update|publish))\b/u,
      /^(?:\S*\/)?coolify-api\b/u,
      new RegExp(String.raw`^${PM}\s+publish\b`, "u"),
      /^(?:vercel|netlify)\b.*(?:\bdeploy\b|--prod\b)/u,
      /^wrangler\s+(?:deploy|publish|pages\s+deploy|versions\s+deploy)\b/u,
      /^(?:fly|flyctl)\s+deploy\b/u,
      /^fastlane\b/u,
      /^xcrun\s+(?:altool|notarytool\s+submit)\b/u,
      /^docker\s+push\b/u,
      /^(?:kubectl\s+apply|terraform\s+apply|helm\s+(?:install|upgrade)|firebase\s+deploy|eas\s+(?:submit|update))\b/u,
    ],
  ],
  [
    "test",
    [
      new RegExp(
        String.raw`^${RUNNER}turbo\s+(?:run\s+)?(?:test|typecheck|lint|check|format:check)(?::[\w:-]+)?\b`,
        "u",
      ),
      new RegExp(
        String.raw`^${PM}\s+${PM_FLAGS}(?:run\s+)?(?:test|tests|typecheck|lint|check|verify|e2e|format:check)(?::[\w:-]+)?\b`,
        "u",
      ),
      new RegExp(
        String.raw`^${RUNNER}(?:vitest|jest|mocha|ava|playwright\s+test|eslint|oxlint|knip|tsc\b.*--noEmit|biome\s+(?:check|lint|ci)|prettier\b.*--check|oxfmt\b.*--check)\b`,
        "u",
      ),
      /^(?:python3?\s+-m\s+)?(?:pytest|mypy|ruff|pyright|flake8)\b/u,
      /^(?:go\s+(?:test|vet)|cargo\s+(?:test|check|clippy|nextest)|swift\s+test|(?:bun|deno)\s+test|(?:make|just)\s+(?:test|check|lint|ci))\b/u,
      /^xcodebuild\b.*\btest(?:-without-building)?\b/u,
      /^(?:rspec|phpunit|ctest|shellcheck)\b/u,
      /^tldr\s+diagnostics\b/u,
    ],
  ],
  [
    "build",
    [
      new RegExp(
        String.raw`^${RUNNER}turbo\s+(?:run\s+)?build(?::[\w:-]+)?\b`,
        "u",
      ),
      new RegExp(
        String.raw`^${PM}\s+${PM_FLAGS}(?:install|i|add|remove|rm|update|up|ci|format|codegen|generate|(?:run\s+)?build(?::[\w:-]+)?)\b`,
        "u",
      ),
      new RegExp(
        String.raw`^${PM}\s+(?:run\s+)?private:(?:web|ship)\b.*--prepare`,
        "u",
      ),
      new RegExp(
        String.raw`^${RUNNER}(?:(?:vite|tsup|esbuild|rollup|webpack|next)\s+build|tsc|prettier|oxfmt|biome\s+format)\b`,
        "u",
      ),
      /^(?:cargo|go|swift)\s+build\b/u,
      /^(?:xcodebuild|make|cmake|ninja|gradle|\.\/gradlew|mvn)\b/u,
      /^(?:omnyo|bb)\s+plugin\s+(?:build|new|types)\b/u,
      /^git\s+(?:add|apply|mv|rm|checkout|switch|restore|stash|rebase|worktree\s+add)\b/u,
      /^(?:mkdir|mv|cp|rm|touch|chmod|ln|patch)\b/u,
      /^(?:sed\s+(?:-\S+\s+)*-i|perl\s+-\S*i)/u,
      /^drizzle-kit\s+generate\b/u,
      /^(?:pip3?|uv|poetry|brew)\s+(?:install|add|sync)\b/u,
    ],
  ],
  [
    "investigate",
    [
      /^git\s+(?:status|diff|log|show|blame|branch|rev-parse|ls-files|ls-tree|grep|remote|describe|reflog|fetch)\b/u,
      /^gh\s+(?:(?:pr|issue|run|release|repo)\s+(?:view|list|status|checks|diff|watch)|api)\b/u,
      /^(?:cat|head|tail|less|nl|wc|ls|tree|find|fd|rg|grep|ag|jq|yq|stat|file|du|df|which|pwd|ps|lsof|env-names|tldr|bat|diff|cmp|sqlite3|curl|wget|op-meta|sed\s+-n)\b/u,
      /^(?:omnyo|bb)\s+(?:thread|threads|project|provider|status|logs?|diagnostics|guide|machine|settings)\b/u,
    ],
  ],
];

const COMMAND_RANK: Record<CommandPhase, number> = {
  investigate: 1,
  build: 2,
  test: 3,
  ship: 4,
};

export function classifyShellCommandPhase(
  command: string,
): CommandPhase | null {
  const shellCommand = extractShellCommandFromString(command) ?? command;
  let result: CommandPhase | null = null;

  for (const segment of shellCommand.split(/\s*(?:&&|\|\||;|\||\n)\s*/u)) {
    const unwrapped = segment
      .trim()
      .replace(
        /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|time|nohup|env|command|exec|rtk(?:\s+proxy)?|timeout\s+\S+)\s+)+/u,
        "",
      );

    if (
      /^(?:cd|sleep|echo|printf|true|false|set|export|source|\.|:)(?:\s|$)/u.test(
        unwrapped,
      )
    )
      continue;

    const phase = COMMAND_PATTERNS.find(([, patterns]) =>
      patterns.some((pattern) => pattern.test(unwrapped)),
    )?.[0];

    if (
      phase !== undefined &&
      (result === null || COMMAND_RANK[phase] > COMMAND_RANK[result])
    )
      result = phase;
  }

  return result;
}
