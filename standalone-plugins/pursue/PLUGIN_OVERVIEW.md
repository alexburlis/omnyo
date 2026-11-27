Keep an Omnyo thread working toward a goal, or have Omnyo wake it with a prompt until
something changes.

## What you get

- `omnyo pursue goal <objective>` — after each turn, an independent judge thread
  decides whether the objective is met and nudges the thread onward until it is.
- `omnyo pursue loop <interval> <prompt>` — a check wait owned by Omnyo, not by the
  agent process, so it survives a thread restart and is listable.
- `omnyo pursue status` / `omnyo pursue list` — see what is running.

Works on every provider (Claude Code, Codex, Pi, ACP), because it operates on
Omnyo threads rather than inside a provider session.

## How it works

A goal is the chat's own producer in Omnyo's Inbox. After each turn it spawns a
hidden judge thread in the worker's own environment and reads its one-line
`MET` / `UNMET: …` verdict. Omnyo holds the turn's result until then: UNMET drops
it and Goals sends the worker a continuation naming what is still missing;
MET, the limit, a clear or a judge failure surfaces one Inbox card. A met goal
is removed outright, so nothing keeps showing live work after it is achieved;
a goal that stops short stays as a muted, dismissible pill with its reason.

A loop is an Omnyo check wait. Omnyo wakes the chat with the prompt; a check that runs
`omnyo wait rearm` because nothing changed stays silent, and one that reports
something ends the wait, after which Goals opens the next.

See README.md for design notes and the failure modes they guard against.
