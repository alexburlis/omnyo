Bundled as `omnyo--composer-predictions`. The server prewarms suggestions for idle,
completed chats on every provider. The composer shows them on first paint without
requesting or waiting for inference.
The composer displays the suggestion through `experimental_setSuggestion`.
Send submits it; Insert or Tab inserts it, Cmd+Z undoes the insert, and Escape
dismisses it. Typing and new turns invalidate it. `request --force` runs inference now.
Finished chats always get a suggestion.

The server prewarms successful chats at startup, on chat changes and every
three minutes, one prediction at a time with a four-minute bound. Pending questions, queued messages and active work
exclude a chat; Decisions, callbacks and resources separately gate positive archive
verdicts. Eligibility is rechecked before accepting a result. Dismissal and
cancellation stop a suggestion. Transient failures retry after 1, 5 and 20
minutes then every 20, exhausted allowance after 30 then every 90; configuration,
model and version failures wait for Retry. An unavailable machine retries on reconnect.

Codex generates predictions for every chat provider through an existing
Account Pooler subscription. Each prediction requires verified included allowance
and a zero credit balance. See [account and allowance](README.md#account-and-allowance).

The same call returns an advisory archive verdict with a short reason: likely
ready, more work remains, or waiting on an outside event nobody in the chat can
speed up, such as App Store review, which makes the chat's status External.
Ready means the requested outcome is delivered with proportionate evidence and
no material obligation remains. A completed plan, draft or preparation step does
not wait for unrequested execution, optional follow-up or owner installation of
an offered update. A required external outcome blocks only when it belongs to
the requested finish line. The `report_chat_outcome` agent tool records evidence
outside the visible reply. A report applies only to the matching input and
successful turn. A reported blocker overrides a positive prediction. When
allowance runs out, a current report or prediction can still supply an assessment.
The verdict never archives a chat.
The `status` and `request` CLI/RPCs expose `archiveReadiness` (ready, reason,
waitingOn, ask, recap), null before a successful prediction. A new turn or queued work clears both assessments; open
work withholds the recommendation in core without touching the verdict.
Chat Topics receives a type-of-work tag for untagged or prediction-tagged chats.

Verdicts bind to the conversation and run once per completed turn after owned work.

Settings pick Codex or Claude per chat provider; each chat defaults to its own. Claude runs `claude-haiku-5-5` without tools on subscription accounts, never API keys. Transcripts use redacted Omnyo events; oversized context fails visibly, unlogged.

Archive assessments also expose `ask` and `recap`. `ask` names the single
user decision, approval, access or information required to continue, or is null
when the user owes nothing. A ready assessment always has a null ask. `recap`
summarizes the result and changes since the user's last message in at most two
sentences. Older assessments default both fields to null. Composer Predictions
publishes these fields with the assessment for the server-owned Inbox state and
reason. A private report supplies the outcome or next action as the recap.
