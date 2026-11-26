**Experimental. We’re unaware of account bans from using this plugin. Provider terms do not clearly address every use of these features. Use at your own risk.**

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
matters, such as when a spent account returns. An amber stretch on the bar
marks an account using its week faster than the week passes. There is no
separate Usage page.
The pending reset-attempt storage key remains stable.

An account whose subscription login stopped working reads **Signed out**
with **Sign in again**, which runs Account Pooler's re-login for that account
right in the details; other account errors read **Unavailable** with **Retry**.

Opening the details checks each enabled Codex OAuth account's reset credits
through Account Pooler and shows a line only for an account that has some, with
the soonest expiry. **Use reset** redeems
the credit that expires first, only after the user confirms. The provider credit ID and
request ID remain stable across an uncertain response and manual retry. Usage
refreshes only after the reset is acknowledged. Automatic retry, paid Fast mode,
new accounts and billing changes are absent.

The server accepts only this built-in caller for the protected reset RPCs and
keeps credentials inside Account Pooler. Startup preserves enabled intent from
the old `account-usage` ID before plugin loading and disables that old registration.
Existing downstream choices take precedence. Normal operation needs no Terminal
or custom launcher.
