The builtin Account Pooler plugin is on by default. Until an account is added
each machine authenticates through Claude Code or Codex. Add an Anthropic API
key or a Codex account to serve matching threads through the pool.

```sh
omnyo pool account add --provider codex --login [--label <text>] [--priority <n>]
omnyo pool account login-poll --session <id>
omnyo pool account login <id>
printf '%s\n' "$ANTHROPIC_API_KEY" | omnyo pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
omnyo pool account add --provider claude --api-key <key> [--label <text>] [--priority <n>]
omnyo pool account list [--json]
omnyo pool account remove <id>
omnyo pool account enable <id>
omnyo pool account disable <id>
omnyo pool account priority <id> <n>
omnyo pool account reorder <claude|codex> <id>...
omnyo pool account refresh <id>
omnyo pool account reset-credits <id> [--json]
omnyo pool account reset <id> --confirm --request-id <uuid> [--credit-id <provider-id>] [--json]
omnyo pool status [--json]
omnyo pool routing <claude|codex> [--off]
omnyo pool config
omnyo pool config set <anthropicUpstreamBaseUrl|codexUpstreamBaseUrl|switchThreshold|parentMode|composerPredictionAllowance> <value>
omnyo pool parent [proxy|isolate]
omnyo pool token rotate --machine <id-or-name>
omnyo pool bypass <thread-id> [--off]
```

Every command accepts `--json` and `--help`. `omnyo pool --help` lists the
commands; `omnyo pool <command> --help` prints that command's arguments, options,
and rules, including which flags cannot be combined. Unknown commands, unknown
flags, and stray arguments are rejected with the nearest suggestion rather than
ignored, and a failing invocation that carries `--json` also prints
`{"ok":false,"error":{"code","message","hint"}}` on stdout.

Reset credits use the selected enabled Codex OAuth account. Listing returns live
credit identifiers, statuses and expiry; no credentials leave Account Pooler.
The versioned owner RPCs are `experimental_codex-resets.v1.credits` and
`experimental_codex-resets.v1.redeem`, authorized for the Account Usage plugin.
Redeem accepts `{accountId, creditId?, redeemRequestId}` and returns
`{accountId, code, usageRefreshError}`. Credit identifiers are opaque provider
strings; the request ID is a UUID. The CLI requires `--confirm` and an explicit
request ID. Reuse the same account, credit and UUID after an uncertain failure.
The provider returns `reset`, `already_redeemed`, `no_credit`, or
`nothing_to_reset`. After the first two, the pool reads fresh usage and publishes
the change. A failed usage read returns an acknowledged result with a visible
warning; it does not submit another reset. Listing and redemption use internal
OpenAI endpoints and may fail if that provider contract changes. No checkout,
purchase, arbitrary authenticated fetch, credential export or account failover
is available through this interface.

For a Claude subscription, sign in directly in Claude Code on the machine that
runs the thread. Account Pooler only accepts Anthropic API keys for Claude.
Old Claude subscription entries remain visible so you can remove them. Use
`omnyo pool bypass <thread-id>` to resume a thread through its machine's Claude
Code sign-in if its pooled subscription was retired. Anthropic bills usage on
pooled API keys.

Codex `--login` prints a device verification URL, one-time code, session ID,
and an `account login-poll` command that waits for authorization. The browser
may be on another machine. In Account Pooler settings, use **Sign in to Codex**.

Use `omnyo pool account login <id>` or **Sign in again** in settings to renew a
Codex login in place. The RPC is `codexLogin.start` with
`{ kind: "relogin", accountId }`. Finish with `login-poll`. The login must
match the existing ChatGPT account and workspace. The account keeps its ID,
priority, enabled state, pinned conversations, and quota observations. A
successful renewal clears its credential error.

An enabled account with a usable credential is available on the next request.
Routed sessions receive a separate pool token for their machine. Claude Code
also receives `ENABLE_TOOL_SEARCH=true` for tool references through the pool.
Routed Claude Code also receives `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`, so it
neither reads nor refreshes this machine's Claude login. Features that need
that login (Claude in Chrome, claude.ai connectors, Remote Control) stay off in
routed threads; use `omnyo pool bypass <thread-id>` for a thread that needs them.
Claude Code removes `ANTHROPIC_AUTH_TOKEN` from tool subprocesses in this mode,
so route a nested `claude` explicitly with
`ANTHROPIC_AUTH_TOKEN="$OMNYO_ACCOUNT_POOL_PARENT_TOKEN" claude ...`.
Claude Code skips its served model catalog behind the pool and lists only the
models it cached under a personal login, so the pool also contributes
`OMNYO_CLAUDE_MODELS_URL`. The Claude Code model picker then lists the models
that pooled accounts can use from that hub route, newest first after Claude
Code's default, including newly released ones.

Codex receives `CODEX_OPENAI_BASE_URL` and the secret
`CODEX_POOL_AUTH_TOKEN`; Omnyo applies them as in-memory app-server config.
Codex image generation and editing use the same authenticated pool route.
Tokens are never printed. `status` prunes tokens for unenrolled machines and
shows token timestamps plus recently routed threads whose machines need a
local Claude login before the pool can be disabled safely. Rotation keeps the
prior token valid for ten minutes. Agents should pipe API keys to
`--api-key-stdin`;
`--api-key <key>` is an unsafe compatibility form that exposes the key in
process arguments, shell history, and agent transcripts. Codex quota refreshes
on add, enable, or re-login of an enabled account and every five minutes while
an account is idle. When a request finds no
eligible account, the pool first refreshes the OAuth accounts it considers
exhausted, at most once every 30 seconds per account, so a plan upgrade or an
early reset takes effect on the next turn. Use
`omnyo pool account refresh <id>` to request an immediate refresh for one account.
For an OAuth account in error, `refresh` also forces a new token with the stored
refresh token and clears the error when that succeeds, so a spurious error does
not require logging in again.
When the token endpoint rejects an OAuth refresh token (HTTP 400 or 401), the
pool stores a SHA-256 fingerprint of that token, never sends it again on its
own, even after a restart, and keeps serving the stored access token. The
account enters error once that access token expires or upstream rejects it; an
API key enters error when it is rejected. `omnyo pool account login <id>` replaces
the login and clears both the error and the stored fingerprint.
`omnyo pool account enable` clears the error, but an unchanged rejected refresh
token puts the account back in error as soon as its access token has expired;
`refresh` retries the rejected token once the account is errored. A 401
or 403 on a freshly refreshed OAuth token is treated as an upstream failure
instead: the request gets HTTP 503, and that token is held out of routing for
one minute.
Account tables add columns for observed model-family buckets; JSON status
exposes their utilization, reset, status, observation time, and source under
`familyWeekly`. Selection skips an account whose requested family is spent
while retaining it for other families when limit observations are present. Use `omnyo pool config` to
inspect the full routing configuration and
`omnyo pool config set <key> <value>` to update one value. The upstream URL keys
are QA-only overrides; `switchThreshold` must be greater than 0 and at most 1.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account below that threshold and wraps at the end. Accounts above the threshold remain usable while the provider allows them; they serve before paid fallback when no account has more headroom. An allowed window at 100 percent stays usable, while an unclassified window at 100 percent is spent. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor.

An HTTP 408, 500, 502, 503, 504 or 529 response, or a connection failure,
before the response starts, retries a pinned conversation on its own account
first: up to twice, after 1 and then 2 seconds, or after the response's
`Retry-After` when that is at most 20 seconds. Prompt caches stay with the
account, so a move would rewrite the whole cached context. When the retries
fail, or the wait is longer, the request fails over to the next account, and
the session's pin moves to the account that served it, where its context is now
cached. Conversations without a pin fail over at once. The cursor
and session pins survive hub restarts. Session pins expire after 65 idle minutes,
and the pool retains the 4,096 most recently used pins.

Codex honours Retry-After before its own reconnect attempts, so a long wait
would leave the chat silently "working". When the pool tells Codex to wait more
than one minute, including when every Codex account has spent its included
usage and credits, it answers with Codex's `usage_limit_reached` error and the
expected reset in `resets_at`. Codex then ends the turn with a usage-limit
failure, and Provider Retry schedules the retry from the pool's availability.
Waits of one minute or less stay ordinary retryable rate limits.

Codex account listings show an Extra usage column. In JSON, `extraUsage` includes
its status, observation time, and source. The state survives hub restarts.

Codex plans do not all include every model. When Codex lists models through the
pool (`GET /v1/models`), the pool answers with the list of the account it routes
to and stores that list for the account and that `client_version`; it keeps the
three most recent versions per account. It also fetches the list of every other
enabled account that has no current stored list for the same `client_version`,
with that account's own credentials. When the routing account's list changed
since it was last stored, the pool fetches every other account's list again.
When a routed turn returns an `X-Models-Etag` that matches none of the serving
account's stored lists, the pool drops that account's lists, at most once every
10 minutes, so the next listing fetches them again. A stored list stays current
for seven days, until the account's plan (`subscriptionType`, refreshed from
ChatGPT usage) changes, or until the account signs in again. The listing waits at most 3 seconds for these fetches; a slower
fetch still stores its list for later answers. A failed fetch is retried for
that account after 5 minutes. The answer keeps the routing account's entries
unchanged and appends each model that another enabled account's current list
for the same `client_version` shows, copied as ChatGPT sent it. Appended entries
get priorities after the routing account's entries, so they never displace the
routing account's own models. Codex still marks its configured default model
(`model` in `config.toml`) as the default whenever any enabled account offers
it, and a chat using that model runs on an account whose plan lists it instead
of switching to another model. A spent account still contributes its list, so a model only its plan
offers stays selectable until its reset. An account in error contributes nothing.
When models or speed tiers are added, the answer carries its own ETag, and the pool rewrites
the `X-Models-Etag` header of routed turns from contributing accounts to that
ETag, so Codex does not refetch the list after every turn.

A Responses request for a model goes only to accounts whose current list
includes it, whenever at least one enabled account's current list does. An
account is skipped only when its current list was fetched for the same
`client_version` as a list that includes the model. Accounts without a current
list and accounts in error stay candidates. Skipping an account this way does
not commit an account, move the provider cursor, or move a session pin. When
only spent accounts list the model, the pool answers with their earliest reset
instead of trying other plans. JSON account and status responses expose
`modelCatalog` per account: `plan`, `clientVersion`, `fetchedAt` and the listed
`models`, or null when the account has no current list.

For shared models, Codex sees the speed tiers advertised by the enabled accounts
that list the model for its client version. A request for a speed tier such as
Ultrafast uses an account whose current catalog advertises that tier for the model.
Eligible accounts still follow the pool's quota and priority rules. If they are all
spent, the pool reports their earliest known reset. If no current catalog confirms
support, the pool returns an error. Refresh Codex's model list to recheck account
capabilities. A temporary change of account for a speed tier preserves a usable
session pin for ordinary requests.

ChatGPT can still reject a model for an account. The pool treats a Responses request
(`POST /v1/responses`) as a plan rejection only when an error message begins
with ChatGPT's sentence for the requested model: "The '<model>' model is not
supported when using Codex with a ChatGPT account". It reads `detail`,
`message`, `error.message` and `response.error.message` in an HTTP 4xx body or
in a `response.failed` or `error` stream event. Other errors pass through
unchanged and record nothing, including a bare `model_not_found` code and a
message that only quotes part of the sentence. Other Codex routes, such as
search and images, are never inspected and never skip an account.

After a plan rejection, the pool records that account as incompatible with that
model for its current plan. It then resends the same request to the next
eligible account within the same turn, before any output reaches Codex. The
rejection does not commit the account, move the provider cursor, or move a
session pin. Later requests for that model skip the account, including
conversations pinned to it, while other models keep using it. The record
survives hub restarts. It clears when the account's plan (`subscriptionType`,
refreshed from ChatGPT usage) changes, when the account signs in again, when a
request for that model succeeds on the account, or after 24 hours. To find the
rejection before streaming starts, the pool holds a Codex stream's opening
lifecycle events (`response.created`, `response.in_progress`) until the first
other event, for at most 2 seconds or 64 KiB.

The pool never records the last enabled account that might still accept the
model. When ChatGPT also rejects the model for that account, Codex receives
ChatGPT's own rejection unchanged, and the next request tries that account
again. When every enabled account already has a record or a current list
without the model, for example after the remaining compatible account is
disabled, the records and lists stop steering routing: the pool routes the
request as usual and returns ChatGPT's answer. A single request therefore cannot
lock the whole pool out of a model.

When every compatible account is spent, the pool answers with
`usage_limit_reached` and the earliest reset among compatible accounts, and
Provider Retry availability reports that same time for the turn's model. The
pool never substitutes another model. JSON account and status responses expose
`incompatibleModels` per account: `model`, `plan`, and `observedAt` for each
active record. In nested proxy mode, the parent also checks the model and tier for a request with
an explicit Codex speed tier.

When only credits or extra usage remain, the pool spends them first on accounts
whose current plan has rejected a different model, or whose current model list
omits a model that another account's list for the same `client_version` shows.
For example, a Luna request uses a Free account's credits before a Plus
account's credits, which stay available for models only Plus can run. Records
older than 24 hours still count here until they clear for the reasons above.
This preference applies only to paid fallback: included allowance still comes
first, and conversations pinned to another credit account move to the preferred
account. A preferred account that a request skips for its model keeps the
provider cursor.

Codex credits use the same fallback policy and availability pill. The pool reads
`credits.has_credits` and `credits.unlimited` from usage responses and the
corresponding `x-codex-credits-*` headers. Credit-only updates are accepted;
omitted fields preserve prior observations. Workspace hard stops (the
`workspace_{owner,member}_{credits_depleted,usage_limit_reached}` limit types,
or a reached spend control) block routing even below the subscription switch
threshold and survive restarts. Other limit types, including unknown ones, do
not restrict the account. A refreshed allowance or spending-control observation can
clear the matching restriction. JSON account/status responses expose
`usageRestriction` (reason and optional reset time); the pool does not change
workspace spending controls or purchase credits. Availability is not current
billing activity.

Drag an account’s handle in Account Pooler settings (or focus the handle and use
Space, arrow keys, and Space again), or
`omnyo pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `omnyo pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.

## Nested Omnyo servers

An Omnyo server started from inside another Omnyo server's thread inherits that parent's
pooler routing through its environment. The parent contributes
`OMNYO_ACCOUNT_POOL_PARENT_URL` and `OMNYO_ACCOUNT_POOL_PARENT_TOKEN` alongside the
provider routing variables, and the nested server enables the pooler on first run
when it sees them.

`omnyo pool parent` reports the detected parent, the current mode, and which
providers the parent can serve. `omnyo pool parent proxy` and `omnyo pool parent
isolate` set the mode; `omnyo pool config` shows it as `parentMode`.

In `proxy` mode the nested server runs its own hub and mints its own machine
tokens, forwarding pooled traffic upstream with the parent's token, so the
parent's token is never handed to the nested server's agents. It reads the
parent's `/availability` endpoint and contributes routing only for providers the
parent can actually serve; if the parent is unreachable it contributes nothing
and neutralises inherited provider routing. Claude API-key forwarding requires
the parent's updated Account Pooler route. A parent with only the older Claude
route remains unavailable to the nested server.

In `isolate` mode the nested server contributes empty routing variables, which
overrides the inherited values so threads fall back to that instance's own
accounts or to each provider's own credentials.

Proxied traffic authenticates as the parent machine's token, so `omnyo pool status`
on the parent attributes it to the parent host rather than to the nested
instance.

## Automatic retries

Provider Retry discovers Account Pooler’s `provider-retry.v1.availability` RPC. It accepts `{ threadId, requestId }` and reports `not-routed`, `ready`, `blocked` with `retryAt` in epoch milliseconds, or `unavailable` with a reason. Pool routing must have been recorded when the provider environment was prepared. The request must still be the thread’s latest request; its recorded model determines which quota windows apply. The pool uses the same recovery calculation for its HTTP 429 response and this RPC. Parent pools expose the authenticated `/retry-availability?provider=claude|codex&family=<family>` endpoint.

The retry plugin remains responsible for queueing, maximum waits, and attempt limits. Inspect a skipped decision with `omnyo provider-retry explain <thread-id>` and pending work with `omnyo provider-retry status <thread-id>`.
