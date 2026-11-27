---
name: glance
description: Update or inspect the Glance live card for a Omnyo chat, which answers the chat's goal, where it stands and what is next, with deliverables and execution-linked proof under Details.
---

# Glance

Update the chat card at the end of each substantive turn. Keep the card consistent
with the visible answer and any reply format an installed plugin requires. The conversation
owns the full recap; the card answers three questions at a glance and nothing more.
The card does not replace the answer. Make no additional model or provider call.

## The three rows

The open card is a status pill with a small phase strip, then three short rows.
A busy owner should understand the chat from these rows alone:

| Row  | Field      | Answers                               | Length     | Example                                         |
| ---- | ---------- | ------------------------------------- | ---------- | ----------------------------------------------- |
| Goal | `goal`     | What did the owner ask this chat for? | ≤ 80 chars | `Redesign the Glance card around goal and next` |
| Now  | `headline` | Where does that request stand?        | ≤ 90 chars | `New card is live; old chats keep working`      |
| Next | `next`     | Who acts next, and what do they do?   | ≤ 80 chars | `The owner picks the release scope`             |

- **Goal:** the original request as a plain phrase, not the chat title copied
  verbatim and not the current step. Set it on the first card. Later cards
  that omit `goal` keep the previous one; send a new goal only when the owner
  changes the request. Without any goal, the card shows the chat title instead.
- **Now:** where the chat's main request stands and its impact. Say what is true
  now and why it matters, for example `Checkout works on iPhone again; no lost
  orders`. Report side requests in facts, not this row. Do not narrate process, such as gates, check counts, apply
  attempts, timestamps, paths, commands, event IDs or internal version strings,
  unless the reader must act on that value.
- **Next:** who acts next and what they do, for example `The owner picks the
  release scope` or `The agent runs the device check`. Omit it once the chat is
  done. When the Tidy plugin is installed, its **Ready to archive** mark replaces
  the Next row when Omnyo's current work summary recommends archiving; until then
  a done card shows **Not marked ready to archive yet**. Without Tidy, a done card
  shows no Next row. Agents cannot set readiness.
- **Blocker:** only for `blocked`. It appears in red in the Next row, so name what
  cannot proceed and who or what unblocks it once; put the concrete action in
  `next` without restating the explanation.
- **Decisions:** use Omnyo native questions through `AskUserQuestion` or
  `omnyo question command`. Glance is status-only: never duplicate a prompt,
  options or answer controls in a card. Set `needs-you` while the native form
  awaits an answer, and use `next` to name who answers it.

Everything else sits under one closed **Details** toggle: at most three `facts`
that do not repeat the rows, `deliverables`, `proof` and the changes since the
reader last looked. Commands, run results and file paths belong in `proof` and
`deliverables`, never in the rows. Write each row so it reads well on a phone:
short, concrete, no jargon, one point per row. Never join unrelated outcomes
with `·` or `and`.

The title-bar pill and the side card beside the chat show only a summary: the
chat title as **About**, `goal` as **Started**, then `headline` as **Toward**
while the chat is under way, or **Result** once it ends. A done result shows
`sidebarSummary` (else `headline`) in green; a blocked result shows `blocker` in
red. Write `headline` so it reads as what the chat is working toward, and use
`blocked` with a blocker when the chat ends without the requested outcome. The
status dot is blue while working, green when done and red when blocked or failed.

The phone composer card keeps all rows. Working and done cards start minimized to one line: the status pill, the Now
line (or `sidebarSummary` when done), a **Ready to archive** pill when the
optional Tidy plugin recommends archiving, and the update time. Attention statuses open on each new
revision.

The card marks itself **Chat moved on** when a later turn starts without
updating it. Update the card in the same turn so that the reader never sees an
out-of-date state.

Prefer `glance_set`; use `glance_show` to inspect the current card. Running sessions
can lack newly installed tools. In that case, use:

```sh
omnyo glance set --card-stdin <<'JSON'
{"status":"working","phase":"test","goal":"Fix checkout on iPhone","headline":"Fix is in; the focused checks are running","next":"The agent reads the check results"}
JSON
```

Omnyo requires one line of JSON and at most 16 KiB. Use a quoted heredoc so the shell
cannot execute card text. `--chat CHAT_ID` selects an explicit chat; omission uses
the invoking chat. `omnyo glance show [CHAT_ID]`, `diff [CHAT_ID]` and `list` accept
`--json`. `.` means the invoking chat; outside a thread, name a chat.

## Card fields

| Field            | Contract                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `status`         | `working`, `needs-you`, `blocked`, `done`                                                                                             |
| `phase`          | `investigate`, `build`, `test`, `ship`, `done`                                                                                        |
| `goal`           | Optional 1–120 characters, aim for ≤ 80: the Goal row, the owner's original request                                                   |
| `headline`       | 1–160 characters, aim for ≤ 90: the Now row, where the main request stands                                                            |
| `sidebarSummary` | Optional, done only: 1–64 characters; the main request's single outcome, result first, ideally at most 55                             |
| `blocker`        | Only and always for `blocked`: 1–300 characters naming the blocker and its owner                                                      |
| `facts`          | 0–8 objects, aim for ≤ 3: label 1–60, value 1–120, tone `neutral`, `positive`, `warning`, `negative`, `info`, `muted`                 |
| `deliverables`   | 0–8 objects: title 1–120, href, optional meta 1–160 and explicit project-image preview                                                |
| `proof`          | 0–10 objects: claim 1–200, kind `reproduced`, `inspected`, `hypothesis`; optional command 1–300, positive integer eventSeq, ref 1–300 |
| `next`           | Optional 1–200 characters, aim for ≤ 80: the Next row, who acts next and what they do; omit once done                                 |

Arrays default to empty. Keep each text value on one line. `reproduced` always
requires `command`; use the exact command from this chat. When repeated runs make
a command ambiguous, supply the selected completed command's `eventSeq`. Omnyo can
record shell wrappers such as `/bin/zsh -lc`; use the explicit sequence when the
recorded wrapper differs from the command text. Inspect the selected actual command.

## Visual deliverables

After uploading a capture to project attachments, add a deliverable `preview`
with `kind: "project-image"`, `projectId`, project-relative `path`, `mimeType`
and `alt`. The main `href` still opens the deliverable. PNG, JPEG and WebP previews
are limited to 4 MB. Optional `visualRequestId` and `role: "before" | "result"`
pair actual captures. Never store image bytes or a browser host's local file path.
The Cards view shows at most two visual references per chat; images load when
visible. Image reads do not acknowledge unread cards or answer native questions.
Saving retains each preview for the card's owning thread until the image's last
owning thread is deleted. A retention failure keeps the previous card intact.

## Honest status and proof

Use `needs-you` only for one real user answer or approval. Do not invent approval
needs for authorized work. Use `blocked` only for a concrete external gate, and
name who can unblock it. Use `done` only when the whole requested outcome is
delivered and required verification is complete. Only the user can accept a
narrower finish line. A partial trial, refusal, stopped run or delegated handoff
does not complete a larger request. Keep unmet outcomes working or blocked by
their actual required gate.

A reproduced entry links only to one exact normalized completed command in this
chat, or its explicit event sequence. The server matches command headers in the latest 500 completed events through one compact lookup;
ambiguous/missing evidence remains **Not linked**. Read the actual linked command,
status and exit code. Linking execution does not prove the claim. Never claim
success from a failed run or from evidence for another product, device or surface.
New linked proofs retain at most 3,000 characters of already-redacted command
output, including truncation markers, within 50 revisions plus the seen baseline.
Older snapshots may lack excerpts; say so when the missing output matters.

Never include credentials, private raw history, provider environment values or
other people's private data in the card. Use useful artifact links and concise
facts. Preserve the existing user-facing evidence and proof boundaries.

Example status while a native question is pending:

```json
{
  "status": "needs-you",
  "phase": "ship",
  "goal": "Ship the new onboarding to testers",
  "headline": "The tested build is ready; it waits for your release choice",
  "facts": [{ "label": "Checks", "value": "Focused checks passed", "tone": "positive" }],
  "next": "The owner answers the release question below"
}
```

Example finished card:

```json
{
  "status": "done",
  "phase": "done",
  "goal": "Fix checkout on iPhone",
  "headline": "Checkout works on iPhone again; no orders were lost",
  "sidebarSummary": "iPhone checkout fixed; no lost orders"
}
```

The Next row shows **Ready to archive** only when the Tidy plugin is installed and
Omnyo's current work summary recommends archiving. Core combines a source-bound completion assessment with
current obligations. The assessment can use an explicit agent report without
prediction allowance. A done card or a stopped turn does not set readiness.

`ask` is rejected on new card writes. Existing stored decision payloads are
read as status without changing their original revisions.

## Completed sidebar previews

For done cards, supply `sidebarSummary` through `glance_set` or the same CLI JSON.
It also replaces the headline on the minimized chat card and the Inbox line. Write
the single outcome of the chat's main request, ideally at most 55 characters, at
most 64, result first. Leave out side requests handled in the same chat. Never join
unrelated outcomes with `·` or `and`. Skip “Implemented”, “Successfully”, repeated
chat titles, versions, IDs and prose about checks unless they are the outcome.
Good: `iPhone checkout fixed; no lost orders`, `Sidebar rename works on
desktop and mobile`. Bad: `Pricing page live · search fixed on 2.4.1`,
`1,293 native tests passed · draft updated`. Keep necessary limits, such as
`emulator`, when they change the claim. Older cards without this field show
a word-boundary headline excerpt of at most 64 characters with an ellipsis when
shortened. Other statuses keep their current preview and attention prefixes.

Card loading uses a direct `card.read` RPC as the chat route opens. The composer
shares that read; history/cursor capture remains separate. `card.get` and CLI show
retain captured cursors. Cards are not marked seen until matching history arrives.

## Dev servers on each chat

`omnyo glance servers [chat] --json` reads the current chat's active managed previews
and its most recently observed inactive server. The desktop composer shelf exposes
Open for a running preview and Restart for a stopped saved recipe. On mobile, the
chat header's server button shows the count and status and opens those controls in
Omnyo's drawer. The recent stopped server shows "Last seen running …" when it was
observed online before, or "Not seen running yet" when it has only a registered recipe.

For a server the user will open, read `omnyo guide previews`, then use
`omnyo preview register --thread <id> --url <fixed-loopback-url> -- <verified-command...>`
and `omnyo preview restart <preview-id>`. Then run
`omnyo glance servers --remember <preview-id>` to associate the returned binding
with this chat, including a recipe reused from another chat in the same workspace.
Register the exact argv and working
directory on the owning host. When the server needs credentials, launch it through
the project's existing script or launcher that loads them; never put secrets in
recipe arguments. Do not infer a command from an old URL or
adopt an unrelated process. Existing `omnyo preview status` and `restart` commands
use the same lifecycle owner as the shelf.
