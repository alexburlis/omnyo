# Skill Discovery

A local Omnyo plugin for organizing skills and saved prompts. Keep discovery and previews read-only. Write library metadata only through revision-checked operations. Install files only after an exact, destination-bound pack review. A selection never executes a skill, sends a prompt, or calls an AI provider. Do not introduce additional provider spend.

Use only the public Omnyo plugin SDK pinned in package.json. Source previews use the selected workspace host and exact file returned by discovery. Plugin-owned instructions use the skills API. Never substitute another source after a read failure.

Use pnpm, matching package.json and pnpm-lock.yaml. Run typecheck, lint and format:check; build with omnyo plugin build. Verify meaningful changes in the installed Omnyo UI using tests/live-browser.md. Preserve every source variant and apply provider/scope filters to the same variant.
