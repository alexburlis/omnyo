# Account Usage

Bundled into the private Omnyo distribution as `omnyo--account-usage`. Live Claude and
Codex usage stays visible in the bottom rail as one small ring per provider.
The ring shows the account serving a request now, or else the most recently
used one; a provider with a single account always shows that account. With
neither, the ring shows the average weekly percentage left, or the next
capacity time when nothing is usable. The ring stays quiet while capacity is
healthy and turns amber or red at 20% or 5% left or less. A clock marks a
waiting account and shows when it returns, a `5h` tag marks a nearly spent
five-hour window, a refresh arrow marks a stale reading, `–` means no current
reading and `off` a disabled account. Hovering a ring names the account,
window, capacity left and reset time, and the bar's label reads every account
aloud. Hovering the rings with a mouse, or clicking or tapping them, opens
the details, as a bottom sheet on phones, sized to fit every account without
scrolling. A click keeps hover-opened details open. Each account gets one
line: its plan, a weekly bar with a tick for
the time left in the week, the percentage left, and the next change that
matters. That is when a spent account returns, a reached or nearly spent
five-hour limit, a model or longer window tighter than the week, or otherwise
the weekly reset. An amber stretch on the bar marks an account using its week
faster than the week passes. Bars sit on a neutral track; an account that is
resting until a reset, or signed out, shows a greyed bar and percentage, and
the account serving a request has a soft glow in its status color. The time
tick is hidden at the very start and end of the week. When every account
shares one email domain, the
names drop it; hovering a name shows the full address and when it was last
used. A refresh control sits in the header. There is no separate Usage page.
The pending reset-attempt storage key remains stable.

Temporary read failures keep the last successful usage snapshot and its original
timestamp visible, labeled Stale or Offline. Account Usage shares concurrent
pool reads and gives each internal read thirty seconds, so a slow answer on a
busy machine is not reported as a failure; a read with no answer by then reports
"no answer within 30 seconds". The display retries snapshot reads after one,
two and four seconds, then returns to its normal 30-second polling. Recovery
cancels pending retries. A confirmed missing or disabled pool clears cached
readings. Provider refreshes and credit resets are never repeated by these
retries.

Failed reads log their operation, method, elapsed time and bounded socket error
causes, including native error codes and connection addresses. Credentials,
headers and request or response bodies are excluded.

An account in error gets one plain line under it instead of the raw provider
message, which stays in the line's tooltip. A dead subscription login, such as
an OAuth refresh rejected with `invalid_grant` or `refresh_token_expired`, reads
**Signed out** with **Sign in again**. That starts Account Pooler's re-login
for the same account inside the details: Claude opens the sign-in page and
takes the pasted code, and Codex shows the device code with **Copy & open** and
waits for approval. The sign-in survives closing the details. After it
completes, Account Usage refreshes that account's usage once and shows
**Signed in again**; a failed usage refresh stays visible. Other account errors
read **Unavailable** with **Retry**, which refreshes that account's usage
once. Reset credits stay hidden while an account is signed out. Account Usage
only relays these requests to Account Pooler's existing login and refresh RPCs;
it never sees credentials, and only the client may call them.

Opening the details checks each enabled Codex OAuth account's reset credits
through Account Pooler. An account with credits gets a line with their count,
the soonest expiry and **Use reset**; an account without any shows nothing
extra, and screen readers hear that none are available. Listings load
asynchronously and stay cached in memory for three hours across closing and
reopening the details. Reopening shares an unfinished check. The provider refresh
control, an acknowledged reset, or a browser hard reload requests a fresh listing.
A check that exceeds 80 seconds shows a retryable error. Cached credits remain
visible during a refresh.

**Use reset** redeems the credit that expires first, only after the user confirms.
The provider credit ID and
request ID remain stable across an uncertain response and manual retry. Usage
refreshes only after the reset is acknowledged. Automatic retry, paid Fast mode,
new accounts and billing changes are absent.

Account Pooler accepts only this built-in plugin's identity for its protected
reset RPCs and keeps credentials inside Pooler. Startup preserves enabled intent from
the old `account-usage` ID before plugin loading and disables that old registration.
Existing downstream choices take precedence. Normal operation needs no Terminal
or custom launcher.

The Account Usage client RPC `codexRedeemReset` requires `accountId`, a selected
`creditId`, a stable UUID `redeemRequestId`, and `confirmed: true`. App, CLI and
SDK clients must obtain explicit confirmation before calling it. Calls through
other plugins' SDK identities are rejected before forwarding to Pooler. The confirmation field
expresses request intent; it does not prove human presence. Saved attempts from
the previous UI remain manually retryable with their original identifiers because
that UI saved them only after confirmation. No saved attempt retries automatically.

When an account has spent its included allowance and Account Pooler reports
credits, its ring and detail line show the credits left instead of the reset
time, with no warning color while credits remain and red at zero. The provider average
shows the provider's total credits when no account has included allowance left. Accounts
without a credit reading keep the reset countdown.

Account details show reported credit balances in points or the provider's currency,
including a reported zero, as a compact amount beside the account name, muted
while the account draws from credits and red at zero. Hovering it, or a screen
reader, gives the exact balance. Unlimited credits and available credits with an
unknown balance are labeled separately. Credit readings use their own observation
time and are marked stale after eleven minutes. Missing balances are not inferred
from plan quotas, reset credits, or monthly spending limits. Codex balance amounts
require the matching Account Pooler credit-balance update.

## Speed and allowance measurements

The account details keep **Codex speed** collapsed by default. Expand it
to see median estimated output tokens per second and the number of measured
turns over the last 30 days. Each model appears once, with Standard, Fast and
Ultrafast columns. The **Thinking** selector compares the same effort across
tiers. Above the table, Fast and Ultrafast speeds are shown as multiples of
Standard for the named model. Counts include only turns used in each median.
Stats supplies the measurements across all Codex chats.
Output includes reasoning; recorded tool time is excluded. These are turn-based
estimates, not decoder timings. Missing speed measurements show a plain empty
state instead of zero-completion rows.

Open **Allowance details** to filter allowance observations by account. Stats
does not provide exact usage-to-account attribution, so the panel does not label
its generation speeds as belonging to a particular account.

Allowance readings are observed account-window changes, not exact per-request
charges. Mixed-tier activity, unfinished requests, reset transitions and readings
below the provider's percentage resolution are excluded from comparisons.
Direct usage outside the pool and delayed provider accounting can still affect
an otherwise homogeneous interval. The allowance details flag incomplete
collection. The panel never starts a benchmark or requests extra provider quota
refreshes.

Account Usage's `telemetry` RPC reads Stats `report` and Account Pooler's
`experimental_telemetry.v1.report` concurrently. Its `speedRows` come from Stats;
allowance data comes from Pooler. An unavailable speed source fails visibly
without substituting Pooler's request measurements. The same speed measurements
are available through `omnyo stats report --range month --group model --filter provider=codex --json`.
`omnyo pool telemetry --json` remains the read-only interface for Pooler's
metadata-only request and allowance collector. These reads start no model calls
or provider quota refreshes. No prompts, generated text, response headers or
credentials are retained in Pooler measurement rows.
