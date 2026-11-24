---
name: browser-automation
description: Use the Browser Automation Omnyo plugin to inspect and automate persistent browser pages in an explicit desktop or local headless session. Use for browser navigation, snapshots, clicking, forms, and verification screenshots.
---

Use `omnyo browser-automation`. Open one session, retain its session ID, then inspect,
act, and verify in short scripts.

`--machine` accepts an exact host ID or an unambiguous machine name. Exact IDs
take precedence over names; unknown or ambiguous names fail before opening a session.

Choose `--backend local --headless --machine <host-id>` for headless Chrome on
an enrolled host. Choose `--backend desktop --machine <host-id> --desktop
<instance-id>` for a new desktop automation tab. Desktop tabs use the Omnyo
browser's profile, including the user's signed-in cookies. Starting desktop
control opens the side panel and selects the browser tab only if its thread is
already focused. New or activated controller pages follow the same rule;
automation does not switch threads or bring the desktop window forward. While
controlled, a desktop tab never takes keyboard focus from the composer or other
apps; the user presses Take over to type into it. Headless sessions remain headless.
Plugin-owned local/headless Chrome uses Chrome's sandbox. A host that restricts
unprivileged user namespaces must enable a supported Chrome sandbox before opening
a local session. Desktop attachment does not change the browser's launch flags.
Resolve the explicit instance with `omnyo browser instances --host <host-id> --json`
first. Never silently choose a different host or mode.
Adding `--tab <tab-id>` takes control of an existing tab; do so only when the
user asked to use that tab. The CLI uses the
current thread, or `--thread <id>` outside a thread. Each session belongs to
that thread.

CLI opening:

```sh
omnyo browser-automation open --backend local --headless --machine <host-id> --json
omnyo browser-automation open --backend desktop --machine <host-id> --desktop <instance-id> --json
```

Run scripts:

```sh
omnyo browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.goto("https://example.com"); const state = await p.snapshot({interactive:true,track:"main-interactive"}); state.full' --json
omnyo browser-automation screenshot <session-id> --page main --json
```

For an action within the observed document, use a ref from the latest observation
and return its result in the same script. Replace `<observed-ref>` below with
that ref; never copy a ref number from an example:

```sh
omnyo browser-automation run <session-id> --script 'const p = await browser.getPage("main"); await p.click("ref/<observed-ref>"); const state = await p.snapshot({interactive:true,track:"main-interactive"}); state.incremental' --json
```

Tracked snapshots return `{full, incremental}`. Return only one field. The first
incremental observation is full; later observations show changed semantic-tree
lines or `(no changes)`. A large change returns an explicitly labeled full tree.
This reduces repeated output; the runtime still reads the current tree.

Return `.full` after navigation, reload, changing snapshot options/scope, or
losing the prior observation from context. Use the same track and options to
update its baseline before resuming deltas. The tracker does not automatically
reset on navigation. If an action might navigate, return `.full` afterward.
Keep distinct tracks for distinct pages or observation scopes. Use `scope`,
`depth`, or `maxChars` when more focused context is sufficient.

Take a fresh full snapshot before using refs after navigation or document
replacement. Refs identify observed elements, not permanent controls; changed
or removed elements may require fresh refs. Do not mix refs between sessions,
pages, or browser runtimes. An unchanged semantic tree does not prove unchanged
appearance. Request a screenshot when visual verification matters. Use
`await p.shot({type:"jpeg",maxEdge:960,quality:70}); undefined` inside scripts to
return a bounded JPEG file.

`run` and `screenshot` return JSON with `hostId` and `images`, where each image
has `path`, `mimeType`, `width`, and `height`. The path is in this chat's
storage on host `hostId`. Use your image-reading tool on the path when you are
on the same machine. If that host differs, fetch the image to
local temporary storage first (substitute the returned path and host ID):

```sh
omnyo file read '<image-path>' --host '<host-id>' --json | node -e '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const file = JSON.parse(fs.readFileSync(0, "utf8"));
if (file.contentEncoding !== "base64") throw new Error("Expected binary image");
const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "browser-image-")), "capture.jpg");
fs.writeFileSync(destination, Buffer.from(file.content, "base64"), {mode: 0o600});
console.log(destination);
'
```

Read the printed local path with your image-reading tool. Do not print base64
image bytes into the conversation. Returned paths are already in this chat's
storage and survive closing the session; link them directly. Remove local copies
when finished.

A local headless `open` returns a `previewDirective`, for example
`::browser-preview{session="<session-id>"}`. Copy it into your next message
exactly once as a standalone line, before you continue working. Do not wrap it
in backticks or a code fence, and do not invent or edit the session ID. Omnyo
renders it as a live view of that browser in the chat, which the user can
expand, so they can watch while you work. Desktop
sessions return no directive; that browser is already visible in the side
panel. `omnyo browser-automation preview <session-id> --json` reports the live
frame's `url`, `title`, size, and `sequence` without image bytes; it is not a
substitute for `screenshot` when you need to see the page.

`pages` lists persistent pages. Runs serialize within a session. Scripts are
trusted JavaScript with Puppeteer-style DevBrowser APIs, not a sandbox.
`--script-file` requires `--script-host <host-id>` naming the source host explicitly. Browser file
operations and `localhost` refer to the browser host. Transfer files explicitly.

Stop cancels running and queued work and releases desktop control. Cancellation
and timeout stop the session too; open a new session to resume. A run whose
output passes 512 KB fails with exit code 1 but keeps the session open; return
or print less and run again. Close disposes
owned Chrome and desktop tabs the session opened while preserving a `--tab` tab.
Close sessions after use. When `close` or `stop` fails, the session still
accepts no more commands, but its browser may still be running; run `close`
again to retry cleanup. `run`, `pages`, and `screenshot` renew expiry at their start and completion to
30 minutes later, capped at eight hours from creation. Active scripts are not idle;
the hard deadline still stops running work. `list` and live preview do not renew
expiry. Desktop leases and connections cannot be renewed through the current API,
so desktop sessions still end at their earlier deadline (at most 30 minutes from
creation). Timeouts default to 30 seconds, maximum 120 seconds: pass either
`--timeout-ms <1000-120000>` or `--timeout <duration>`, where a duration carries
a unit (`90s`, `2m`, `1500ms`) and a bare number is read as seconds (1-120) or
milliseconds (1000-120000).

A run may return at most 4 screenshots, JPEG only, 500 KB combined; a larger or
differently encoded capture fails the run. `omnyo browser-automation --help` and
`omnyo browser-automation <command> --help` print every flag with these limits.
Unknown commands and flags fail with a suggestion, and with `--json` a failure
prints `{"ok":false,"error":{"code":…,"message":…,"hint":…}}` on stdout (code
`session_unavailable` when the session stopped, expired, lost its worker or
browser, or its work was cancelled or timed out, `screenshot_limit` for capture
limits) while the same message stays on stderr. Session failures include a hint
to open a new session; cancellation and timeout also suggest increasing
`--timeout` up to 120 seconds when a script needs longer.

An unavailable backend or a failed runtime install is an actionable setup
error, not permission to attach to a random browser. The first open on a host
installs the pinned `dev-browser` npm release into plugin-owned host storage
there and verifies its provenance and digest; it needs npm, network access, and
Chrome on that host, and can take a minute. Later opens reuse the verified
install offline. The exact pin and Chrome setup are documented in the plugin
README. Cloud browsers and arbitrary CDP endpoints are unsupported.

## Responsive visual feedback

Expand a local/headless preview to use Phone, Tablet or Desktop. These controls
change actual Chromium metrics and touch behavior. Restore viewport restores the
exact prior emulation only while this preview still owns the applied values.
Preset changes invalidate frozen selection; notes remain in the draft.

Choose Annotate to freeze a fresh image and bounded element context for the exact
displayed target. Select an element in the image or the element picker, write a
note, then add it to the originating chat. Captures upload to that chat's project,
so they survive session closure and work across machines. Multiple notes append to
one draft without sending it. Failed or stale captures preserve the note; refresh
the selection after navigation, reload, resize or layout changes.

The same operations are available through SDK plugin RPC and CLI:

```sh
omnyo browser-automation preview <session-id> --json
omnyo browser-automation viewport <session-id> --target <target-id> --preset phone --json
omnyo browser-automation observe <session-id> --target <target-id> --json
omnyo browser-automation inspect <session-id> --target <target-id> --observation <observation-id> --element <element-id> --json
omnyo browser-automation viewport <session-id> --target <target-id> --preset original --json
```

Use the returned target and observation IDs, never a guessed `main` page.
`observe` returns bounded visible element metadata and one JPEG file reference;
`inspect` validates the frozen document, viewport, element identities, geometry
and content before and after capturing one visible crop. CLI output omits image
bytes. Copy/upload the image from its returned browser host before closing the
session. The app does this through project attachments before appending it to the
bound thread's composer. Presets and captures share the existing session run queue;
the preview stream remains a read-only observer. Desktop tabs use Design Mode.
