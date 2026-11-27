# Glance

- Keep `contract.ts` the shared card/RPC boundary. Validate external data once,
  then use typed values internally. Keep the app and server contract aligned.
- Use public SDK history APIs. Never retain raw provider history, environment
  values or arbitrary tool arguments/results. Persistent redacted
  command-output excerpts are allowed: at most 3,000 characters per proof,
  including truncation markers, with 50 revisions plus the seen baseline. Do not
  replace or bypass the core redactor.
- A proof link proves execution only. Preserve actual command, status, exit code
  and event sequence. Match an explicit same-thread completed command or a unique
  exact normalized command; never use substring or tool-name matching.
- Mark only the displayed revision and captured event cursor seen. Keep both
  monotonic and retain the last seen revision while pruning newer history.
- Keep reply counts truthful: completed assistant-message IDs, bounded scan and
  a separate more-activity indication. Do not label them conversation counts.
- Use the standalone package checks and SDK test harness with real SQLite.
  The harness owns and retires its temporary databases on disposal.
- Code comments are forbidden except semantic tool directives. Add no model
  calls, paid provider features, service accounts or infrastructure.
