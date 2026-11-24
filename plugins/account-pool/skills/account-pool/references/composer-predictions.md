# Composer predictions

The protected `experimental_composer-predictions.v1.predict` and `.cancel`
RPCs accept requests from the bundled Composer Predictions plugin. The coordinator
binds the request to a completed chat and checks the work basis before and after
inference.

Account Pooler selects an eligible Codex subscription for every chat provider,
including Claude Code. The shared text-inference path checks included allowance
and zero available credits before dispatch, disables tools, and validates the
streamed response. The request contains bounded chat text, excluding tool outputs
and attachment contents. It returns one suggested reply and archive assessment,
or a reason to omit the reply when other work owns the next step.

The composer and its read-only diagnostics show when Codex routing or eligible
allowance is unavailable.
