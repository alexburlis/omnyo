# Branch Tree

A native Omnyo **Branch** button and a sidebar that keeps related chats together.

Click **Branch** in the chat header to create an empty fork and open it directly.
The composer receives focus and the sidebar switches to the tree.
The new chat inherits Omnyo's conversation context, provider, execution settings,
and checkout. The source keeps its own unsent draft. No message is sent by the plugin.
The same action appears on sidebar rows and their menus.

```text
An original conversation    Original
Try a different direction
  Refine that direction
    Explore another detail
A second direction
```

First branches align with their original. Further branches indent beneath their
source. Chevrons collapse branches; opening a nested chat reveals its ancestry.
Collapse preferences persist in the browser. Deep trees cap indentation so
titles and controls remain usable. Large lists render only visible rows.

Families stay adjacent and follow their original chat's project and section.
Pinning any chat keeps its family in Pinned. Existing native forks are grouped
automatically through `sourceThreadId`; no history migration or plugin metadata
is needed. Hidden and archived chats stay hidden; visible orphan branches remain
accessible. Ordinary delegated children are separate chats.

The sidebar retains Omnyo's status and plugin marks, unsent drafts, jump shortcuts,
drag-to-split, inline rename, pinning, read state, and native archive/delete
confirmation. The tree options menu can restore Omnyo's project view.
Select **Branch Tree** under **Settings → Appearance → Sidebar** to return.
Other plugins' sidebar headers and status integrations remain available.

## Install locally

Requires Omnyo 0.45+ and Plugin SDK 0.6.15+.

```sh
pnpm install --frozen-lockfile
omnyo plugin build .
omnyo plugin install .
```

A fresh installation selects the tree. Reload does not overwrite the user's view.
Omnyo's fork API remains authoritative: the source needs an available provider
session and a ready workspace. Unsupported providers are disabled in the header.
Failures are shown as a toast and leave the source draft intact.
Forks share the checkout; they do not create Git branches or worktrees.

## Verify

```sh
pnpm typecheck
pnpm lint
pnpm format:check
omnyo plugin types --check .
omnyo plugin build .
pnpm test:e2e
```

The Chrome E2E script uses the current `OMNYO_PROJECT_ID` and `OMNYO_THREAD_ID`, or
explicit values with `OMNYO_TEST_URL`. It checks the installed frontend on live
read-only data and intercepts fixture mutations. It never sends an agent prompt
or creates, archives, or deletes a real chat. `evidence/` contains screenshots
and the repeatable receipt; fixture fork results do not establish provider
execution. All imports use the public SDK.
