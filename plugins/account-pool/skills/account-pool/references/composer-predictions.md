# Composer predictions

The protected `experimental_composer-predictions.v1.predict` and `.cancel` RPCs
accept only `omnyo--composer-predictions`. The server derives the completed source
and host from the Omnyo thread. The result includes suggestion text, prompt version, archive assessment,
and `noSuggestionReason`. New native output requires a nonempty reason when the
suggestion is null or blank, and null when a suggestion is present. Missing
reasons from older hosts default to null at the RPC boundary and mean the reason
was not recorded. This preserves parsing of older result payloads;
it does not invent a reason or a waiting state. The canonical prompt changed, so
executing predictions requires the upgraded host protocol. Accepting older result
payloads does not make older host execution compatible. For Codex threads, the shipped host entry makes an ephemeral native
prediction fork and never starts a turn on the parent. Codex is the supported prediction backend. For chats from other providers,
selecting Codex sends the redacted accepted user and completed assistant messages
to an ephemeral Codex session on the thread's machine using the configured model
(default `gpt-6.1-sol`). The legacy Claude prediction backend reports that it is
unavailable.
A Codex thread predicted by Codex uses the transcript route too when its local
rollout can no longer be loaded or OpenAI lists its model as unsupported for
native predictions; other native failures stay visible. The host call allows
155 seconds, inside the native runner's 150-second bound plus cleanup.

The predict input may carry up to 64 type-of-work tags (`id`, `description`).
With tags, the prompt appends their list and a required `tag` (an offered id or
null); without tags it is unchanged. The result's `tag` is null when the model
names no offered id, and absent from hosts that predate tags. The capability
accepts the provider prompt with or without one canonical tag list.

`force: true` on the predict input requires a reply. Composer Predictions sends it
for forced requests and for finished chats, where no job, callback, loop or child
chat owns the next step. It replaces the prompt's omission rule, the output
schema then requires a nonempty `suggestion`, and a result without a reply, or
with a reply and a `noSuggestionReason`, fails as an invalid prediction. Without `force`, the model may
omit a reply, with a reason, only when other work owns the next step. In both modes
a suggestion may ask for the approval the assistant is waiting on, never for more
than it proposed; the repetition limit, result contract and archive assessment are
unchanged. Both the native and transcript routes use it. The capability is bound to
its request: a required-reply capability accepts only the required prompt, and an
ordinary one only the ordinary prompt.

Native prediction homes clone the complete `forkedFromId` rollout chain reported
by Codex `thread/read`, preserving paginated history and the original model.
Unreadable or cyclic ancestor lineage fails visibly; it never selects a different
conversation context merely because the isolated clone is incomplete.

The pool reads OpenAI's fixed predictions configuration endpoint internally and
keeps the same account for configuration and inference. A single-use capability
stays within the 165-second prediction operation, including setup and inference.
Cancellation and source changes revoke it immediately. The capability permits
only the provider prediction prompt and never stores the response. Native forks
retain Omnyo function declarations; the pool always forwards
`tool_choice: "none"`, and the native session refuses tool and approval requests.
Accounts require OpenAI's prediction eligibility. By default, predictions require
fresh included Codex allowance; paid credits or missing credit metadata do not
exclude an account with included allowance. Explicitly set
`omnyo pool config set composerPredictionAllowance included-or-prepaid-credits`
to allow fresh finite prepaid credits when no account has included allowance.
Included allowance takes priority. Credit-only eligibility requires observed
`has_credits: true`, `unlimited: false`, and credit and usage observations no older
than 60 seconds. Missing, stale, depleted and unlimited metadata fail visibly.
Restore `included-only` to stop authorizing credit-only requests, including
prepared requests awaiting forwarding. OpenAI may overdraw credits. Automatic
reload is provider-managed; disable it in OpenAI before opting in when new
purchases are forbidden. Omnyo never purchases credits or changes automatic reload.
Omnyo does not claim the official desktop beta's free-billing treatment. API keys
and parent-pool proxy mode remain unavailable. Cancellation, source changes and
disposal revoke the capability.
Fresh response-header utilization below the switch threshold can establish included
allowance when the window has a future reset. Empty, invalid or missing utilization
does not establish allowance. Reset-only updates retain the utilization's original
observation time. Current rejections, holds and workspace restrictions remain in
force. A delayed usage refresh preserves newer response-header observations.
Native shutdown closes stdin first so Codex can close its MCP workers, then
terminates the owned child within a bounded time.

Remote source hosts require Omnyo's existing public app URL. Without that URL,
predictions run only on the configured primary host. Settings and normal composer
UI live in the bundled Composer Predictions plugin. No custom launcher is needed.

Manual and background predictions honor the same `composerPredictionAllowance`
setting. With `included-only`, neither uses prepaid credits. With
`included-or-prepaid-credits`, both prefer included allowance and may use fresh,
finite prepaid credits. The current policy is rechecked before forwarding Responses,
so switching credits off revokes prepared credit-only requests.

OpenAI enables predictions per plan. When the configuration endpoint answers
`is_enabled: false` or HTTP 404 (free plans) for the selected account, the pool records that account as
disabled for its current plan and selects again in the same request. It tries
the remaining accounts with included allowance first. Under
`included-or-prepaid-credits`, it then tries accounts with fresh finite prepaid
credits. Each account is tried at most once per request. A recorded account
never holds the lease. A detour past a recorded account never moves the
thread's session pin or the provider cursor, so the chat keeps its account.
Later predictions skip a recorded account without reading its
configuration. The record survives hub restarts. It clears when the account's
plan (`subscriptionType`) changes, when the account signs in again, or after one
hour, so an account OpenAI enables later, for example after a limit window resets,
is checked again. If no remaining account qualifies and a recorded account would otherwise
qualify, the request fails with "OpenAI has not enabled composer predictions for
any available account". `included-only` never falls through to prepaid credits.
JSON account and status responses expose `composerPredictionsDisabled` per
account: `plan` and `observedAt` for an active record, otherwise `null`.

## Archive readiness

The assessment uses the whole requested outcome and proportionate evidence.
Completed plans, reports, drafts and preparation do not wait for unrequested
implementation, sending, payment or external acceptance. A necessary decision or
known missing core verification stays open and names its next actor and action.
Optional tests, speculative follow-ups and owner installation of an offered
update do not by themselves block. The final report is evidence of checks, not
a waiver of a lost deliverable or a material unmet commitment.
