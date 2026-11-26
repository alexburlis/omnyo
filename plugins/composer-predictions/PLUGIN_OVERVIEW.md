**Experimental. We’re unaware of account bans from using this plugin. Provider terms do not clearly address every use of these features. Use at your own risk.**

Choose **Prediction provider** in the plugin settings. **Same chat** is the
default. The current agent can suggest a reply during its normal turn, and
Omnyo shows the saved draft after the turn finishes. **Fixed Codex via Account
Pooler** sends bounded chat context to OpenAI, including from Claude chats, and
supports on-demand regeneration. It requires eligible included Codex allowance.
Turn off **Composer predictions** to stop showing suggestions.

Send submits the draft. Insert or Tab lets you edit it first. See
[account and allowance](README.md#account-and-allowance) for Fixed Codex details.

A prediction can include an advisory archive verdict with a short reason: likely
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
Fixed Codex can suggest a type-of-work tag to Chat Topics for untagged or prediction-tagged chats.

Verdicts bind to the conversation and run once per completed turn after owned work.

Archive assessments also expose `ask` and `recap`. `ask` names the single
user decision, approval, access or information required to continue, or is null
when the user owes nothing. A ready assessment always has a null ask. `recap`
summarizes the result and changes since the user's last message in at most two
sentences. Older assessments default both fields to null. Composer Predictions
publishes these fields with the assessment for the server-owned Inbox state and
reason. A private report supplies the outcome or next action as the recap.
