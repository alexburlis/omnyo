# Branch Tree

This standalone plugin owns `branch-tree/tree` and a one-click chat header action.
Use the pinned public Omnyo SDK. Do not patch Omnyo's DOM or private internals.
Forks use the native `sourceThreadId` relationship and share the source environment.
Do not dispatch a prompt, change the provider, or create a worktree when branching.

First-generation forks align with their original. Deeper forks indent beneath
their source. Keep every visible chat exactly once and keep whole families
adjacent. Family section placement follows the original chat. Pinning any member
keeps the whole family in Pinned.

Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `omnyo plugin build .`,
and `pnpm test:e2e` against the installed frontend. E2E mutations are isolated
HTTP fixtures; never send prompts, delete, or archive a real chat in verification.
