# Composer predictions

The protected `experimental_composer-predictions.v1.predict` and `.cancel`
RPCs accept requests from the bundled Composer Predictions plugin. The coordinator
checks the chat's work basis, completion and source machine before and after
generation. It sends accepted inputs and completed assistant messages to the
worker, without attachment data or tool output.

The worker starts a normal ephemeral Codex app-server thread in an empty
directory. Codex uses its standard OpenAI route and manages credentials in the
dedicated `~/.codex-omnyo-predictions` profile. The worker checks the effective
configuration, instructions, active personal ChatGPT account, included allowance,
and zero credit balance before submitting the transcript. Allowance is a snapshot
taken immediately before dispatch. The process returns a structured reply and an
archive assessment. It may also return one of the offered chat tags. The worker
closes the child process and clears the working directory when the request settles.

The prediction profile and setup are documented in
[Composer Predictions](../../../../composer-predictions/README.md#set-up-codex-predictions).
A missing login or unavailable allowance appears in the composer and read-only
diagnostics. Predictions are independent of Account Pooler routing and accounts.
