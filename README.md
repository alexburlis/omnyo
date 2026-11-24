<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/app/src/assets/omnyo-logo-dark.svg">
    <img src="assets/omnyo-logo.svg" width="80" height="64" alt="Omnyo mark">
  </picture>
</p>
<h1 align="center">Omnyo</h1>
<p align="center"><strong>A local-first workspace for coding agents</strong></p>
<p align="center">
  <a href="https://omnyohq.com">Website</a> ·
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="docs/cli-guide-and-skill.md">CLI guide</a>
</p>

Run Claude Code, Codex, and other supported coding agents on your own machines. Follow their threads in one browser workspace, step in when an agent needs you, and give parallel tasks their own Git worktrees.

## Start from source

Install Git, Node.js 22.23.5 or a later Node.js 22 release, and pnpm 10.34.5. Run the following commands.

```sh
git clone https://github.com/alexburlis/omnyo.git
cd omnyo
pnpm install --frozen-lockfile
pnpm start
```

Open the local URL printed by the launcher. Sign in to your coding provider in its CLI before running an agent. Use `pnpm start --dryrun` to build the required artifacts and inspect the startup configuration without starting services.

## What's included

The source preview includes the coordinator, browser app, CLI, host daemon, and in-tree plugins. The coordinator stores threads and settings in a local SQLite database. Built-in diagnostic collection is disabled in this preview. See the [system overview](docs/system-overview.md).

## Feedback and security

Report bugs and request features in [GitHub Issues](https://github.com/alexburlis/omnyo/issues). Report security vulnerabilities through [GitHub's private reporting form](https://github.com/alexburlis/omnyo/security/advisories/new).

## License and credits

Omnyo is an MIT-licensed fork of [BB](https://github.com/get-bb/bb), created by Michael Yong and the BB contributors. The [MIT license](LICENSE) preserves the original copyright notice. See the [notices](NOTICE) and [upstream credits](docs/upstream-credits.md).
