---
name: workdesk
description: Maintain the user's cross-project action inbox and terse work ledger. Use at turn start, when the user completes an action in chat, at meaningful milestones and before handing back work.
---

# Workdesk

Keep actions and outcomes outside verbose chat replies. Workdesk and chats share one action state.

At **every turn start**, call `workdesk_context` (CLI: `omnyo workdesk context`) and follow `nextOffset` with `omnyo workdesk context <offset>` until null. Read linked actions (including done, dismissed and snoozed) and pending actions from other chats in the project. Never rely on a session-start snapshot: the user can change an item in Workdesk during the conversation.

As soon as the conversation establishes completion of an action, resolve it yourself; the user must not also tick a checkbox. Call `workdesk_resolve` with `{id, revision, evidence}` from the fresh context. CLI: `omnyo workdesk resolve '<JSON>'`. Evidence names the exact decision, approval or observed result, without secrets. **Approval of a release completes an approval item immediately**; actual publication is a separate outcome. An ordinary completion checkbox is a status change, not authorization. **Approve** sends the exact scope to the requesting chat. **Decline** dismisses silently: no message, unarchive, or agent turn. Approval grants only that scope; it never waives a required native approval flow. A declined request must not be executed or recreated. Opening, ending or archiving a chat never proves completion.

Before handing back, fetch fresh context again and resolve newly completed actions. Then call `workdesk_checkpoint`. For linked actions genuinely still requiring the user, pass `{ "pending": [{"id":"…", "revision":"…", "reason":"exact requirement still missing"}] }` (same JSON argument for `omnyo workdesk checkpoint`). Snoozed actions are included in this review but must not become routine reminders. If `recorded:false`, inspect the returned actions, reconcile and retry. Checkpoints reject missing or stale reviews; reporting a milestone does not bypass them. Do not treat an action in another chat as relevant unless the current conversation actually settles it.

Resolution keeps evidence, time and the resolving chat, and updates the dashboard immediately. Re-reporting an old key cannot reopen a done/dismissed action or overwrite its resolution. Respect explicit dashboard reopen/snooze/priority changes.

Record through `workdesk_report`, read existing records with `workdesk_list`, and call `workdesk_checkpoint` once this turn is fully reported (also when there is nothing meaningful to record). These tools are available after the provider session next starts. The CLI works immediately: `omnyo workdesk report '<JSON>'`, `omnyo workdesk list action|work --all`, `omnyo workdesk checkpoint`.

- Only create an action when the user must do something the agent cannot: a required decision, approval, credential, physical action, or external dependency only the user controls. Do not convert ordinary questions, internal errors, suggestions, or agent work into tasks. An approval is needed only where the user's agent instructions reserve the effect for the user. Local exact-path commits of your own verified work, deleting tracked files the work made dead and removing your own scratch are agent work: do them and report the outcome.
- Give each action a stable project-wide kebab-case key. Read first and reuse existing keys across chats. Updates preserve the user's priority, snooze, completion, and dismissal. A genuinely new obligation gets a new key.
- Write about 80% less. Summary: 5–10 words, at most 100 characters. Keep exact versions and targets. Area names the feature; repo is optional when needed to distinguish repositories. Project and source chat are attached automatically.
- P0: immediate harm. P1: time-sensitive or blocks important delivery. P2: required without urgency. P3: required, safely deferrable. Never inflate urgency just because your chat is blocked. Reason explains why only the user can act.
- Work: one meaningful outcome per entry, not one per tool call or retry. Use distinct milestone keys; reuse a key only to correct that same entry. Say what changed and what remains unverified. Outcomes: identified, implemented, verified, shipped. Verified/shipped require evidence of the exact surface. Never equate local tests with production.
- `important: true` only for a material fact the user needs to know even without an action; reason explains the impact. Do not flag routine errors you resolved.
- Details: at most 3 short bullets; aim under 300 characters (hard limit 1200 for exact scope). Reason: one short line, max 120 characters. Evidence: one proof line or artifact link, max 400 characters. Avoid narrative, repeated context and raw IDs in titles. Link longer supporting material; preserve approval scope and limits. Never store credentials, private customer data, or raw logs.
- Use `workdesk_resolve` only after observing completion or that the obligation no longer exists; provide evidence. Never resolve because a chat ended or archived. Don't reopen items the user dismissed.
- Complete reporting before your final reply. A missing report remains visible as incomplete coverage. Archival preserves records and links; permanent deletion leaves the record with a source-deleted label.

Example payload (illustrative, not a real task):

```json
{
  "key": "approve-mac-v24",
  "kind": "action",
  "area": "Mac release",
  "summary": "Publish v2.4 to website and updater",
  "priority": 1,
  "reason": "Production publication needs approval."
}
```

## Prose approval requests

First check that the step genuinely needs the user; if the request or the user's agent instructions already authorize it, do it instead of asking. Batch the approvals you do need: record each once, up front, then keep doing independent work.

When you would otherwise end a reply asking for a yes/no approval, first record an action with `approval: true`. Put the exact operation, version/targets, cost or other limits in `summary` and `details`; each record must be a single decision. The reporting chat becomes its fixed recipient. The UI labels these controls Approve and Decline, distinct from ordinary completion. Approve sends the scope to that chat, resumes it if archived, and queues behind active work. Only confirmed sent/queued approvals leave the open list. Decline immediately leaves the open list without contacting the chat, even if that chat is deleted or unavailable. Its delivery is `not-required`. Delivery uncertainty is visible and is not blindly retried.

Do not mark open-ended choices (such as budget allocation), manual tasks, credentials or native approval-tool interactions as yes/no approvals. Do not duplicate native pending interactions or use Workdesk to bypass a tool/provider-mandated approval. If a native review requires the user’s explicit scope approval in prose, describe that exact scope accurately. Existing reports without `approval` retain their classification. Decisions freeze the request scope; new obligations require a new key. The dashboard’s approved state means authorization was delivered, not execution succeeded. Report actual execution separately in the ledger.

For an existing unclassified yes/no action, use `omnyo workdesk request-approval '{"id":"…","revision":"…","threadId":"existing source chat"}'` after reading its full scope. This only enables the decision buttons; it never approves or sends anything. It also works in older provider sessions whose report tool lacks the new field.
