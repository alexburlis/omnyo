Keep Claude Code and Codex threads running across limits. Account Pooler routes each request through accounts you own.

## What you get

- Open **Add account** in either provider section. For Claude, sign in to Claude Code on the server machine or add an Anthropic API key. For Codex, sign in to ChatGPT with a device code or add an OpenAI API key.
- Accounts run one after another in priority order, with ties following the order added. New conversations stay on the current fallback even when an earlier account recovers. Existing conversations keep their own account until it becomes unavailable.
- Reorder accounts in settings with drag handles or Space and arrow keys, or `omnyo pool account reorder <claude|codex> <id>...`.
- Live account and model-family limits in settings and `omnyo pool status`.
- A routing switch per provider and a per-thread bypass to the thread's own credentials.
- Provider Retry recovery times, Composer Predictions, and selected-account Codex reset credits in the private distribution.

## Routing and cost

Anthropic and OpenAI bill requests served by their API keys. The Codex pool uses available subscription quota before paid API keys.

The switch threshold defaults to 98 percent. It moves new conversations toward accounts below that threshold; provider-allowed subscription quota above it remains usable before paid fallback. Existing conversations keep their included-quota pin while the provider permits it. Usable subscription allowance takes precedence over reported Claude extra usage or Codex credits. Exhausted accounts are checked before fallback. Spending-control and explicit credit-depletion restrictions block Codex routing. The pool does not enable extra usage, buy credits, change spending limits, or treat reported credit availability as current billing activity.

A short rate limit waits once on the same account; a longer one returns Retry-After to pinned conversations while new ones advance. Server, overload and connection errors retry a pinned account twice, then fail over. Model-family limits detour without moving the main pin. A new account is kept after it succeeds. Pins expire after 30 idle minutes; at most 4,096 stay.

Credentials remain on the server. Routed providers receive machine-scoped hub tokens. The pool uses HTTP/1.1 and standard proxy environment variables; connection diagnostics exclude credentials and request contents.

## Predictions and reset credits

Composer Predictions reuses an eligible pooled Codex subscription for all chats.
The coordinator verifies included allowance and a zero credit balance before
submitting the transcript. Cancellation and source changes stop the request.

Account Usage can inspect reset credits for a selected enabled Codex OAuth account. Redemption requires the user's explicit confirmation and consumes an existing credit. An uncertain manual retry keeps the same account, credit and request ID. There is no purchase flow.

## Nested servers

A nested Omnyo server can proxy through the parent pool using its own machine tokens, or isolate routing and use its own accounts. The parent token never reaches nested agents. Proxy mode contributes routing only for providers the parent can serve.

## For agents

Use `omnyo pool --help` and nested `--help` for account, routing, config, parent-mode, token and bypass commands. `omnyo pool account login <id>` renews an existing account; commands support `--json`.

## Automatic retries

Provider Retry uses pool recovery times. Inspect `omnyo provider-retry status` or `omnyo provider-retry explain <thread-id>`.
For exact account, routing and reset procedures, read [accounts and routing](skills/account-pool/references/accounts-and-routing.md). For prediction boundaries, read [composer predictions](skills/account-pool/references/composer-predictions.md).

## Credits

Maintained and extended by Omnyo, based on the [account-pool plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/account-pool). Thank you to Michael Yong and the bb contributors for the original work. The upstream code is [MIT licensed](https://github.com/get-bb/bb/blob/main/LICENSE), copyright (c) 2026 Michael Yong.
