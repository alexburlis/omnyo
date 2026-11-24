<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../assets/omnyo-logo.svg">
    <source media="(prefers-color-scheme: light)" srcset="../../assets/omnyo-logo.svg">
    <img alt="Omnyo" src="../../assets/omnyo-logo.svg" width="128">
  </picture>
</p>

# Omnyo

Omnyo is an agentic IDE that builds itself. It can control, customize, and automate
itself, laying the groundwork for your own software factory.

This package provides the installed `omnyo-app` launcher, bundled `omnyo` CLI entry, and
Node SDK export. Every surface — the web app, CLI, and HTTP API — is a
first-class way to drive Omnyo. Work runs in threads you can follow live, steer at
any point, or hand off to another agent.

> Note: Omnyo is in active development. Workflows and surfaces are still evolving.

## Quick Start

Omnyo uses its verified private publisher and orchestrates coding agents you already have installed.

### Prerequisites

- Node.js 22.19, 24, or 26.
- Git.
- At least one supported agent provider: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/cli), Cursor via ACP, [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), or another ACP-compatible agent.

If you already use one of these providers, Omnyo will pick up your existing
credentials. If you use multiple providers, you can mix and match per task.

### Supported host environments

- macOS and Linux.
- Native Windows workers and bundled CLI through the verified private PowerShell installer.

On Windows, generate a PowerShell enrollment command in **Settings → Machines**
on the private coordinator, then run that command in PowerShell. See the
[private delivery guide](../../docs/private-ship.md) for the existing worker update route.

<details>
<summary>Linux environments inside WSL2</summary>

Run all `omnyo` commands inside WSL2, install Node.js, Git, and your provider CLIs
inside that WSL2 distro, and use Linux-style paths such as `/home/me/repo` or
`/mnt/c/Users/me/repo`.

Inside WSL2, use Linux paths rather than drive-letter or UNC paths. Repos
inside the WSL filesystem are recommended;
`/mnt/c/...` is intentionally supported so you can keep an existing Windows
checkout, but it is slower and less reliable for file watching.

</details>

### Install and run

Use the [verified private release installer](../../docs/private-ship.md), then
run the installed launcher:

```bash
omnyo-app
```

Then open: `http://localhost:38886`.

The private publisher supplies the server, local host daemon, and web app.
Managed state lives under `~/.omnyo/` by default. If either managed child
process exits unexpectedly, the launcher restarts that child without stopping
the other one. Press `Ctrl+C` to stop both processes and exit with status `0`.

The launcher also checks the host daemon's local health every ten seconds. It
allows 60 seconds for startup or a sustained local failure, then terminates only
its owned daemon, escalating to SIGKILL after five seconds if needed. The
existing supervisor restarts it, or a standalone launcher exits nonzero so its
service manager can restart it. Coordinator disconnection alone does not trigger
this check. Sleep or a delayed parent timer starts a fresh failure window.
Recovery can interrupt in-flight agent work; it preserves the data directory and
does not automatically replay model requests.

Application logs rotate in `logs/server.N.log` and `logs/host-daemon.N.log`
under the data directory, keeping the five newest files per service. Output that
bypasses the logger, such as startup errors and crashes, goes directly to
`logs/server-stdio.log` and `logs/host-daemon-stdio.log`. These files append
across restarts; when one is over 10 MB as a service starts, it is renamed to
`-stdio.1.log`, replacing the previous one. The launcher prints status and log
locations without forwarding service output to the terminal, so a stalled
terminal cannot block service logging. To follow everything with the default
data directory:

```bash
tail -F ~/.omnyo/logs/*.log
```

Launcher status output is plain when stdout is redirected, including in CI.
Set `FORCE_COLOR=1` to request color or `NO_COLOR=1` to disable it; `NO_COLOR`
takes precedence. In-place progress updates require a stdout TTY.

The same output capture applies to `omnyo-server` and `omnyo-host-daemon`.

To stop an Omnyo that runs in another terminal or in the background:

```bash
omnyo-app stop
```

`stop` reads `omnyo-app-runtime.json` from the data directory, confirms that the
recorded process really is that launcher, then stops it. Pass `--data-dir` when
the Omnyo you want to stop does not use the default `~/.omnyo/`.

### Updating from the app

When Omnyo has an update, Settings → Updates shows an **Update** button (or run
`omnyo updates app apply`). Omnyo verifies the private runtime staged by its
publisher and reconnects the page after the supported restart. An unreadable
update record or unusable newer runtime stops startup instead of silently
launching an older copy. Use the verified private release installer to repair
an unusable runtime. Pass `--bundled` to explicitly run the installed bundled
copy; unreadable update state remains untouched. Start with
`--no-in-app-updates` to keep in-app updates off.

After the server moves to another machine, the old data directory keeps
`server-moved.json`. `omnyo-app` there starts no server: it runs this computer's
host daemon against the new server address in `config.json`, restarting it when
it exits, and answers the old server port. API requests get `410 server_moved`
with the new address; browser pages redirect to it for a direct address or link
to the configured address. While a move back to this computer is in progress
(`server-import.json`), it frees that port for the incoming server. When
`server-moved.json` goes away, after that move completes or `omnyo server unlock`,
it starts the server and co-located daemon again. `omnyo-server` exits with status
`3` instead of starting, except for the incoming server of a move back.

From the app, add or open a project, start a thread, and choose the provider
you want that thread to use.

## CLI

The package also exposes the `omnyo` CLI for an already-running Omnyo server:

```bash
omnyo --help
```

The CLI uses the same `OMNYO_SERVER_URL` and Omnyo config resolution as the SDK. When
unset, it targets the default local packaged server at
`http://127.0.0.1:38886`.

## Scripting with the SDK

The package also exposes a Node SDK for scripts that drive an already-running
Omnyo server:

```ts
import { OmnyoSdk } from "omnyo-app";

const sdk = new OmnyoSdk();
const thread = await sdk.threads.spawn({
  projectId: "proj_personal",
  environment: { type: "host", workspace: { type: "personal" } },
  prompt: "Summarize my active Omnyo work.",
});
await sdk.threads.wait({ threadId: String(thread.id), status: "idle" });
console.log(await sdk.threads.output({ threadId: String(thread.id) }));
```

`new OmnyoSdk()` uses the same `OMNYO_SERVER_URL` and Omnyo config resolution as the
CLI. Pass `new OmnyoSdk({ baseUrl: "http://host:38886" })` for remote or test
targets (see the remote-access note below). Scripts launched by Omnyo already receive `OMNYO_SERVER_URL` and
`OMNYO_THREAD_ID` in their environment.

## Provider Credentials

Omnyo uses whichever providers you have configured. Common providers:

| Provider       | Setup                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`        | Install the [Codex CLI](https://developers.openai.com/codex/cli). Then run `codex login` or configure credentials per the Codex docs.                                                                                              |
| `claude-code`  | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and authenticate per its docs.                                                                                                                               |
| `cursor`       | Install [Cursor's agent CLI](https://cursor.com/cli) (`cursor-agent`) and authenticate per Cursor's docs.                                                                                                                          |
| `pi`           | Install [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) with `npm install -g @earendil-works/pi-coding-agent` (0.84.0 or newer) and authenticate per its docs; Omnyo can run the install from Settings. |
| `opencode`     | Install [opencode](https://opencode.ai/) and authenticate per its docs.                                                                                                                                                            |
| `grok`         | Install [Grok Build](https://docs.x.ai/build/overview) and authenticate with `grok login` or `XAI_API_KEY`.                                                                                                                        |
| `hermes-agent` | Install [Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/installation), configure credentials with `hermes model`, then verify ACP with `hermes acp --check`.                                             |

Omnyo indexes the documented native skill roots for Codex, Claude Code, Pi,
Cursor, OpenCode, omp, Grok Build, and Hermes Agent. It includes user roots,
project roots, and compatibility roots such as `.agents/skills`. These skills
appear in the selected provider's `/` command menu. The Skills page and
`omnyo skill list` show native skills for Claude Code, Codex, and Cursor. Omnyo also
reads configured Pi, omp, Grok, and Hermes skill directories, plus enabled
provider plugin skills.

Omnyo reads Pi's global `~/.pi/agent` files and each workspace's `.pi` files.
This includes settings, credentials, models, packages, extensions, skills,
prompts, themes, and context files. Pi extensions can add models and tools.
Omnyo loads project resources only after Pi's saved or global trust policy approves
the workspace. An unresolved `ask` decision stays untrusted because Omnyo has no Pi
trust prompt.
You can still use the Pi CLI and `/login` to create this configuration.

Custom ACP agents are configured through the ACP providers plugin's
`customAgents` setting: `omnyo plugin config provider-acp set customAgents
'[...]'`. See the configuration docs for the optional `modelCli` and
`reasoningCli` or `nativeReasoning` reasoning settings. The optional
`nativeSkillRoots` field adds provider-native skills to the composer. Its
`user` paths resolve from the target host home directory. Its `project` paths
resolve from the selected workspace.
Top-level `sharedSkillRoots` uses the same `user` and `project` path format.
Omnyo lists these sources as read-only skills. Omnyo injects them into Codex, Claude,
Pi, and ACP threads. This permits one physical skill collection for Omnyo and a
standalone provider CLI.

## Configuration

Use `omnyo-app config` for persistent non-secret package settings under
`~/.omnyo/config.json`:

```bash
omnyo-app config set OMNYO_APP_URL https://<machine>.<tailnet>.ts.net
omnyo-app config list
omnyo-app config refresh
```

For remote access, publish the default loopback listener with
Tailscale Serve. Direct tailnet or LAN access to port `38886` requires the
explicit, security-sensitive `--server-bind-host 0.0.0.0` compatibility option;
see the multiple-devices guide.

Use `omnyo-app client ssh-target` to configure local editor opens for remote
Omnyo servers under `~/.omnyo/client.json`. The target is the value that works after
`ssh`, such as `devbox` or `user@devbox`:

```bash
omnyo-app client ssh-target set https://omnyo.example.test devbox --host-id host_abc
omnyo-app client ssh-target list
```

Use `omnyo-app env` for provider credentials under `~/.omnyo/env.json`:

```bash
omnyo-app env set OPENAI_API_KEY <key>
omnyo-app env list
omnyo-app env unset OPENAI_API_KEY
```

`env list` redacts all values. Config and env writes ask a running local Omnyo
server to reload; if Omnyo is stopped, the values apply on the next start.

For all config keys, precedence, startup flags, and source-development `.env`
behavior, see the
[configuration docs](../../docs/configuration.md).

## More documentation

- [Platform support](../../docs/platform-support.md)
- [Configuration](../../docs/configuration.md)
- [Using Omnyo on multiple devices](../../docs/multiple-devices.md)
- [Worktree setup and teardown scripts](../../docs/worktrees.md)
