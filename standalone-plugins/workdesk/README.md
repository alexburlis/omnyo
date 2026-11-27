# Workdesk

An Omnyo plugin for the two things that should survive a conversation: required actions only the user can do, and a terse history of meaningful work.

Open **Workdesk** in Omnyo's sidebar (`/plugins/workdesk/overview`). The **Your actions** icon in Omnyo’s sidebar footer opens the same action list in a drawer. The open count appears beside Workdesk in the desktop sidebar. No floating control covers the page or composer.

## Behavior

- Actions sort by P0–P3, then deadline, then age. Expand for instructions, evidence, and all source chats. Complete, dismiss, reopen, change priority, or snooze until an exact time.
- Chat reconciliation: agents fetch linked action states and project-wide pending actions each turn, resolve fulfilled obligations with evidence, and explicitly review anything still pending before handoff. Snoozed items participate; archival and idle never complete an action. Resolution records its time and source chat and survives later reports. Dashboard changes appear in fresh chat context.
- Agent updates preserve the user's priority, snooze, completed and dismissed states. A project-wide key deduplicates the same obligation across chats.
- The ledger filters by project, feature/repo text, last hour/day/week, or a custom time window. Important unread facts have a separate filter across time windows. Records are paginated.
- Work outcomes distinguish identified, implemented, verified, and shipped. Verified/shipped entries require evidence. Agent reports are assertions, not independently audited proof.
- Chat archival preserves records and navigation. Permanent source deletion leaves the saved record and a visible source-deleted label.
- Records live in Omnyo's plugin-owned SQLite database, not in a chat workspace. Plugin reloads preserve them.
- Reporting begins at installation. Existing history is not silently reconstructed. Idle turns without a report/checkpoint are surfaced as missing coverage. The coverage list shows the latest unreported turn per chat, capped at 30.
- Local changes refresh cards, counts and the drawer together; focus and reconnect refresh missed updates.
- Short bullet previews keep old reports compact; full requests and evidence remain expandable. New reports require concise titles, reasons and evidence.
- No extra inference, external service, provider credentials, or recurring agent jobs.

## Approval decisions

Prose-only yes/no approval requests use `approval: true`. **Approve** sends the exact scope to the reporting chat; archived chats resume and active chats queue it. **Decline** silently dismisses: no message or chat activity, even if the source is unavailable. Approvals close as Done after delivery, declines immediately as Dismissed. An ordinary task’s checkmark never authorizes anything. Native approval interactions remain native.

Stale clicks are rejected. A saved decision cannot be silently rewritten, reopened or sent twice by a double-click/reload. If delivery cannot be confirmed, the item stays visible with a warning and source-chat link; the plugin does not retry an ambiguous send. No decision is made by installing the feature.

## Agent reporting

Native tools: `workdesk_context`, `workdesk_list`, `workdesk_report`, `workdesk_resolve`, `workdesk_checkpoint`. Instructions are contributed through the tool registration and `skills/workdesk/SKILL.md`. Omnyo applies tool/instruction changes when provider sessions next start or resume; already-running sessions keep their current configuration.

The CLI is immediately available, including to existing sessions. Old report/checkpoint calls return reconciliation instructions and pending items when review is missing. This is agent-driven semantic reconciliation, not a background classifier: it adds no inference calls and cannot infer unreported completion from merely viewing a chat. Native instruction/tool additions apply when Omnyo next constructs the provider session.

The CLI is immediately available:

```sh
omnyo workdesk context
omnyo workdesk list action --all
omnyo workdesk list work
omnyo workdesk report '{"key":"checkout-fixed","kind":"work","area":"Checkout","summary":"Fixed duplicate purchases; local integration suite passes.","outcome":"verified","evidence":"12 integration tests passed locally."}'
omnyo workdesk resolve '{"id":"ACTION_ID","revision":"CURRENT_REVISION","evidence":"The user supplied the requested exact approval in this chat."}'
omnyo workdesk checkpoint
# If linked actions remain: omnyo workdesk checkpoint '{"pending":[{"id":"ACTION_ID","revision":"CURRENT_REVISION","reason":"Exact requirement still missing"}]}'
omnyo workdesk overview
```

Report commands require an Omnyo thread context so project and source cannot be accidentally omitted. The reporting skill defines admission, priority, evidence, and privacy rules. Agents must list before creating, reuse stable keys for corrections, and use distinct keys for distinct milestones.

## Development and verification

Use Node **22.17.0** (`.nvmrc`), pnpm, and SDK **0.4.104**, matching this installation's contract. The native SQLite test dependency is pinned. Node 24's native SQLite cleanup crashed during testing; Node 22 is the verified test runtime.

```sh
nvm use
pnpm install
pnpm typecheck
pnpm test
omnyo plugin build .
omnyo plugin install . --yes
```

Backend tests exercise real SQLite through Omnyo's official fake host: deduplication, user overrides, archive/delete survival, reload persistence, priority order, project isolation, evidence validation, date filtering, snooze expiry, acknowledgment and reporting coverage. Frontend tests exercise priority editing, completion, archived chat navigation, reconnect reconciliation, project filtering, and the global drawer through the official app harness. Live Chrome verification checks the installed page, drawer, live updates and source navigation.

The source is a local path installation. Disabling the plugin is reversible and preserves its data; removing a plugin is a distinct destructive operation.
