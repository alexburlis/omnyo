# Glance

Glance provides live chat cards, grouped navigation, changes since the last
display and execution-linked proof. Agent tools and the `omnyo glance` CLI
author validated cards through one SQLite write path.
No model call or external provider is involved. Glance is status-only; native Omnyo
questions own every decision prompt, option and answer. Legacy card decisions
are read as status without rewriting their original stored revisions.

The chip reads state and reason from the shared server Inbox snapshot: Needs you,
Failed, Finished, Working, Waiting, Resting or Archive. Failed refreshes retain the last
state with a visible Status stale mark. Saved card revisions remain unchanged.

- **Server:** `server.ts` registers tools, CLI, RPC and thread lifecycle hooks.
  `lib/service.ts` owns atomic revisions, read cursors, pruning and realtime.
  `lib/proof.ts` links only public, redacted completed command events.
- **App:** `app.tsx` and `components/` provide the chat card, page and optional
  sidebar subtitle writer. Hosts with `experimental_threadCompanion` get the card
  as the companion `card`, titled Glance, with a two-row list icon registered as
  `glance/card`; older hosts get the composer banner. The host picks the placement.
  `aside` is a floating card, `toolbar` opens it in a popover, and `inline`
  shows it above the phone composer. All share `components/chat-card.ts`. The aside and
  popover show only a summary (status, About, Started, then Toward or a green/red Result);
  archive actions sit in the composer readiness slot. The aside acknowledges what it shows, the
  pill only while its popover is open, and the composer card while it is mounted.
  `components/loop.tsx` reads the chat's Pursue loop through Pursue's
  `pursue_state` RPC (on mount, every 30 seconds and when the pill opens) and adds
  the pill's countdown badge and the aside/popover Loop section, which edits and
  stops it through `pursue_edit_loop` and `pursue_clear_loop`.
  The composer card is a one-line minimized bar or one
  open card with three rows: Goal (`goal`, else the chat title), Now (`headline`)
  and Next (`next`, the blocker, or Ready to archive, which `components/readiness.ts`
  follows live from Tidy's `omnyo-tidy:readiness` window events plus `ready_ids` on
  load, reconnect and focus). Facts,
  files, proof and changes sit under one closed Details toggle; proof rows expand
  further. Completed cards use a 64-character outcome summary
  instead of repeating the full headline; older cards get a word-boundary excerpt.
  Older hosts without the subtitle setter stay usable.
- **Contract:** `contract.ts` defines card limits, RPC validation and realtime.
  `card.get` returns the view and captured `conversationSeq`; `card.diff` returns
  field deltas, `newReplies` and `moreActivity`; `card.markSeen` requires the exact
  displayed revision and cursor; `cards.index` returns compact card summaries.
- **State:** the coordinator's installer-owned plugin SQLite database holds
  current cards, revisions, proof snapshots, seen state and the last 64 displayed
  revision/cursor pairs per chat. Pending read acknowledgements survive plugin
  reloads. The newest 50
  revisions and the seen baseline survive pruning; thread deletion clears all.
- **Proof limit:** linked execution is not claim verification. Each newly linked
  proof stores at most 3,000 characters of already-redacted command output,
  including any truncation marker. Older snapshots may lack output excerpts.
- **Checks:** contract tests protect conditional statuses and safe links; server
  tests cover actual SQLite state, proof selection, bounded history, cursor
  races, pruning, lifecycle and CLI modes; UI tests cover rendered behavior in
  each placement and the composer fallback for hosts without the companion slot.

See [README](README.md) and [the Glance skill](skills/glance/SKILL.md).
