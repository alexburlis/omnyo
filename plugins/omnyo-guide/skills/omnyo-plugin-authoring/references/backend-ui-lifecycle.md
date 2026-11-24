# Host UI, status, and lifecycle

### api.ui — host-rendered UI (no frontend bundle needed)

```ts
api.ui.registerMentionProvider({
  id: "issue",
  label: "Issues",
  triggers: ["@", "#"], // optional; defaults to ["@"]. Valid: @ # $ ! ~
  search({ trigger, query, projectId, threadId }) {
    // 2s time box, failure = empty list
    return [{ id: "42", title: "ENG-42 Fix flake", subtitle: "Todo" }];
  },
  resolve(itemId) {
    // once per unique item AT SEND TIME
    return {
      context: "# ENG-42…",
      experimental_images: [
        {
          type: "localImage",
          path: "/absolute/path/capture.jpg",
          context: "Selected element",
        },
      ],
    }; // attached as agent-only context; throwing BLOCKS the send
  },
});
```

Mention items render under `label` in the menu for each registered trigger.
`experimental_images` may add bounded agent-only `image` URL or `localImage`
path inputs, each with optional `context`. Treat remote and page-derived image
content as untrusted evidence. Invalid images block the send rather than being
silently dropped.
All handlers run server-side. Frontend thread-header actions use
`app.slots.threadHeader`.
There is deliberately no plugin slash-command surface: the composer's `/`
menu lists skills, so a plugin capability that crafts a prompt for the agent
ships as a `skills/` entry instead.

### api.status

`api.status.needsConfiguration(message)` — mark the plugin
`needs-configuration` (shown in `omnyo plugin list` and the UI) instead of
failing. Cleared on the next load.

### api.experimental_reportError

`api.experimental_reportError(error, { operation, code })` sends one
unexpected failure to the server's error reporting (Sentry) when the owner
allows crash reports. `operation` and `code` are fixed identifiers matching
`/^[A-Za-z0-9_.:-]{1,64}$/`; events group by plugin, operation and code.
Keep the error message free of user content and tokens. `api.log` lines never
reach Sentry, so log the failure separately and limit repeated reports
yourself. The fake host records calls in `harness.errorReports`.

### api.onInstall

`api.onInstall(handler)` runs once, right after the user installs
the plugin and its server entry has loaded. It does not run on update,
reload, enable, or server restart, and not for Omnyo's bundled plugins;
reinstalling after removal runs it again. Use it for one-time setup the user
would expect from installing, such as picking the plugin's thread list:

```ts
api.onInstall(async () => {
  const { preferences } = await api.sdk.system.uiPreferences.list();
  await api.sdk.system.uiPreferences.set({
    key: "sidebar.threadListProvider",
    value: "my-plugin/inbox",
    expectedRevision: preferences["sidebar.threadListProvider"].revision,
  });
});
```

A handler that throws is logged and the install still succeeds; the install
waits at most 30 seconds for handlers. In tests,
`harness.lifecycle.install()` runs them.

### api.onDispose and the reload lifecycle

`api.onDispose(hook)` registers cleanup hooks in reverse registration order.
During reload, the host first runs the candidate factory. If the factory
throws, the previous generation stays live. If the host discards a candidate
after its factory ran, the host runs that candidate's hooks before closing
its databases and invalidating its API. Asynchronous hooks for a discarded
candidate share a five-second wait budget.

Once the candidate succeeds, the old generation is torn down in order: its WebSockets close with code 1012, the
CLI `ctx.signal` and RPC `experimental_signal` of its in-flight calls abort,
input it requested is interrupted (forms the new
generation raised while loading stay pending), services are aborted and get up
to five seconds each (a hung service marks the plugin degraded until it
stops), WebSocket `onClose` handlers run, dispose hooks run in LIFO order (one
failed hook does not stop later cleanup), and in-flight HTTP, RPC, CLI and
event handlers get five seconds to finish. Callers still waiting after that
get an error saying the plugin was reloaded or disabled; the handler itself
keeps running until it stops on its signal. Then database handles close and
the old `api` object is invalidated. Host-worker replacements retain their leased worker until the replacement
generation is admitted. Disable and removal stop the owned host generation.
Retired handlers still executing remain counted as maintenance activity.
Requests that arrive during this teardown are served by the old generation. Disable, removal and shutdown use the
same sequence without a replacement, and also interrupt every pending input
the plugin owns. A captured `api` from a previous load throws
`PluginContextStaleError` on use — never stash the API object in
module-level state that outlives a load. Omnyo logs that error, and any other
uncaught exception thrown from plugin code, against the plugin and keeps
running.
