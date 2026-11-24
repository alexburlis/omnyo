# Wait event sources

`api.experimental_eventSources.register` adds a family of wait event keys,
`<family>:<target>`. Agents and owners then wait on them with
`omnyo wait --event <key>`, and the chat sleeps until the event happens. The
source only observes: it validates and describes targets and says which ones
fired. Omnyo owns scheduling, backoff, health, the Waiting row, the Inbox item when
a source breaks, the listing in `omnyo wait sources` and dry runs through
`omnyo wait check <key>`.

Start a new source with `omnyo plugin new <name> --event-source`. The scaffold
registers the family `<name>` with the example below, plus its tests and a
skill.

```ts
import type {
  PluginApi,
  PluginEventSourceFiring,
  PluginEventSourceProblem,
} from "@omnyo/plugin-sdk";
import { z } from "zod";

const TARGET =
  /^((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)@([0-9A-Za-z.+-]+)$/;

const packument = z.object({ versions: z.record(z.string(), z.unknown()) });

export default async function plugin(api: PluginApi) {
  api.experimental_eventSources.register({
    family: "npm-version",
    label: "An npm package publishes a version",
    keyFormat: "npm-version:<package>@<version>",
    examples: ["npm-version:@omnyo/plugin-sdk@0.6.45"],
    approval: "none",
    validate: (target) =>
      TARGET.test(target) ? null : "expected <package>@<version>",
    describe: (target) => `npm publishes ${target}`,
    poll: {
      everyMs: 5 * 60_000,
      async check(targets, { signal }) {
        const outcomes: (PluginEventSourceFiring | PluginEventSourceProblem)[] =
          [];

        for (const target of targets) {
          const [, name = "", version = ""] = TARGET.exec(target) ?? [];
          const response = await fetch(
            `https://registry.npmjs.org/${name.replace("/", "%2F")}`,
            { signal },
          );

          if (response.status === 404) {
            outcomes.push({ target, problem: `${name} is not on npm` });
            continue;
          }

          if (!response.ok) throw new Error(`npm answered ${response.status}`);

          const { versions } = packument.parse(await response.json());

          if (version in versions)
            outcomes.push({ target, result: `${name}@${version} is on npm.` });
        }

        return outcomes;
      },
    },
    proof: null,
  });
}
```

## Declaration

| Field       | Rule                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `family`    | 2 to 32 lowercase letters, digits or dashes, starting with a letter. Unique across plugins; `host-reconnect`, `coordinator-version` and `automation-run` belong to Omnyo. |
| `label`     | What fires, at most 80 characters. `omnyo wait sources` shows it.                                                                                                         |
| `keyFormat` | The key shape, starting with `<family>:`, at most 120 characters.                                                                                                      |
| `examples`  | One to five complete keys. Each must pass `validate`; registration throws otherwise.                                                                                   |
| `approval`  | `none`, or `owner` when watching a key runs something on the owner's behalf, such as a command or a request to an arbitrary URL.                                       |
| `validate`  | Returns why a target is malformed, or `null`. It runs synchronously inside `omnyo wait`, so keep it pure and cheap: shape only, no I/O.                                   |
| `describe`  | The Waiting row text for one target. Omnyo clips it to 60 characters.                                                                                                     |
| `poll`      | `{ everyMs, check }`, or `null` for a push source. `everyMs` is at least 60 000.                                                                                       |
| `proof`     | A read-only access check that returns what it proved, such as "gh is signed in to github.com", or `null` when the source needs no access.                              |

Registration throws for an invalid declaration or a family another plugin
registered. Families disappear when the plugin is disabled or reloads; register
them again from the factory.

## What Omnyo does with a poll source

- **When it checks.** Only while a live wait is pending on one of the family's
  keys, never more often than `everyMs`. One `check` call receives every
  distinct pending target of the family.
- **What `check` returns.** `{ target, result }` for each target whose event
  happened; `result` is what the waiting chat receives, at most 2 000
  characters. `{ target, problem }` for a target that cannot be checked, such as
  an item that does not exist. Omit targets that are still waiting.
- **When to throw.** Throw only when the whole source cannot check: signed out,
  offline, rate limited. A thrown error, a check that takes more than 30
  seconds, or a return value of another shape counts as one failure. Omnyo aborts
  `signal` when it stops waiting; pass it to `fetch` and child processes.
- **Backoff and health.** After a failure the next check waits
  `everyMs × 2^failures`, at most six hours. After three failures in a row each
  waiting chat gets one Inbox item, `Can't check "<describe>": <error>`. Three
  problems in a row for one target raise the same item on that target's waits
  only. The next good check clears both. `omnyo wait sources` shows the state:
  `idle`, `ok`, `failing` or `proof-failed`, with the last error.
- **Proof.** Omnyo runs `proof` before the first check and again after a failed
  check. While it fails, `omnyo wait --event` refuses the family's keys with the
  proof's message, and `omnyo wait check <key>` runs the proof again.
- **Approval.** With `approval: "owner"`, a wait that an agent, automation or
  plugin registers on the family's keys becomes a "Watch: …?" proposal; Omnyo
  checks it only after the owner accepts. A wait the owner registers runs at
  once, and only the owner can dry-run these keys.

## Push sources

Set `poll: null` when something tells your plugin about the event, such as a
webhook on `api.http`. Report it with
`api.sdk.experimental_inbox.reportEvent({ key, result })`; only the plugin that
registered the family may report its keys. To subscribe to just the targets
that chats wait on, list them with
`api.sdk.experimental_inbox.pendingEvents({ prefix: "<family>:" })`.

## Reaching a machine

`check` runs inside the server process. To read files or run a command on an
enrolled machine, declare a host entry and call it with
`api.hosts.experimental_client({ contract }).call(method, input, { hostId })`;
put the machine id in the target, as in `file:<hostId>:<path>`. See
backend-foundation.md for host entries.

## Test it

`createFakePluginHost` records registrations; call the declaration directly:

```ts
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./server";

afterEach(() => vi.unstubAllGlobals());

it("fires once the version is on npm", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ versions: { "1.3.0": {} } })),
  );

  const { api, harness } = createFakePluginHost({ pluginId: "npm-version" });

  await plugin(api);

  const source = harness.registrations.eventSources.get("npm-version");
  const signal = new AbortController().signal;

  expect(source?.validate("left-pad@1.3.0")).toBeNull();
  expect(source?.validate("left-pad")).toBe("expected <package>@<version>");
  await expect(
    source?.poll?.check(["left-pad@1.3.0"], { signal }),
  ).resolves.toEqual([
    { target: "left-pad@1.3.0", result: "left-pad@1.3.0 is on npm." },
  ]);
  await harness.lifecycle.dispose();
});
```

Stub `fetch`, or the child process the source runs, so the test stays offline.

## Try it live

1. `omnyo plugin install .` registers the plugin directory.
2. `omnyo wait sources` lists the family with its format and example.
3. `omnyo wait check <key>` validates a key and runs one check: `Fires now`,
   `Not yet`, or the error.
4. `omnyo wait --self --key <key> --for "<text>" --event <key>` waits on it.

Types: `PluginEventSources`, `PluginEventSourceDeclaration`,
`PluginEventSourcePoll`, `PluginEventSourceContext`, `PluginEventSourceFiring`,
`PluginEventSourceProblem`.
