# Vendored anti-slop provenance

Source: private `alexburlis/agent-instructions`, skill `install-anti-slop/assets/anti-slop`. The source repository HEAD at capture was `fcf54342ab25637fb2dda0db69da76485d427ac1`; copied bytes are independently bound by `source-manifest.json`, which is the recoverable pristine snapshot identity. All source files were copied byte for byte.

Installed path: `tools/oxlint/anti-slop`. No rule-source deviations. Omnyo selects required checks and optional review rules through its repository configurations; no direct Effect dependency was found, so the opt-in Effect rules remain unregistered. Vendored code and agent assets are excluded from application lint/format. The Stylistic license and provenance remain under `vendor/eslint-stylistic/`.

Local policy reconciliation (18 October 2026, approved by Alex): mandatory checks follow `AGENTS.md`; blanket comment-justification and public symbol naming bans are disabled because they conflict with those contracts. Boundary/type-style and React Compiler optimization findings remain available through `pnpm lint:advisory`. Test fixtures may mock external modules and deliberately construct incompatible values. Production assertion chains and module mocking remain errors. See [Omnyo lint policy](../../../docs/lint-policy.md). The pristine source manifest is unchanged.
