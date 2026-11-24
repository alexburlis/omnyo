---
kind: prompt
title: Child thread question
summary: Delivers a child thread's question to its parent thread instead of the owner.
intent: Have the parent answer its child's question from its own context and authority, or ask its own question when only the owner can decide, then reply to the child.
editingNotes: Child threads never ask the owner directly. Keep the reply command exact, and do not imply the parent can approve or reject on the owner's behalf.
variables:
  childThreadId: ID of the child thread that asked, used in the reply command.
  questions: The child's questions, each with its mode, context and options.
  threadMention: Serialized thread mention token, e.g. '@thread:thr_abc123'.
---
[Omnyo system]

{{threadMention}} asks you, not the owner:

{{questions}}

Reply with `omnyo thread tell {{childThreadId}} --mode auto` and your answer when your context and authority cover it. When only the owner can decide, approve or supply something, ask with your own question tool, then relay the answer to the child the same way. The owner does not see this question.
