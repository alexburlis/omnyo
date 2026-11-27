# Chat Groups

A local Omnyo plugin that groups chats across every project by the attention they need.

Open **Chat view** in the sidebar footer, then use **Projects / Status** to switch views. The Projects button returns to Omnyo's existing Thread list provider and preserves its layout preferences. Your selected view persists across reloads. Installation preserves the selected sidebar provider.

The sidebar has three primary sections. Status groups sit one level beneath them:

1. **Unread**: Needs you, Other chats, Ready to archive.
2. **Read**: Needs you, Unfinished, Ready to archive.
3. **Working**: active turns, background work, queued work and queued/running workflow subagents, even when unread.

Section bars show total parent chats. Smaller status headings show each group's count. Empty sections and groups stay out of the list. Both levels can collapse independently. The section bar stays visible while scrolling.

Within each status, a single project pill and connected frame contain that project's chats. Project names are not repeated on every row. Projects sort by their most recent root, and chats within each project sort by recent attention. Chat titles share an alignment edge, with explicit sub-chat counts beneath. Expand a chat to see its children and expand a child to see deeper sub-chats. Opening a child directly reveals its section, status group and ancestors. Initial parent navigation keeps unread groups visible at the top. Unread child replies and errors stay within that tree; they do not create separate attention entries or make the parent unread. Actual child input requests and live work affect the parent's status. Hidden helpers, archived chats and their branches stay out of the active list. Hidden workflow agents still keep their originating chat Working until every run has finished, including gaps between agent calls.

Needs you includes pending questions, open decisions, unread parent errors and failed queued sends. Ready to archive requires Tidy's explicit completion mark. Other chats and Unfinished have neither an input request nor a completion mark. Status accents use existing theme colors: amber for Needs you, blue for unread other chats, gray for read unfinished, green for Ready to archive, and purple for Working. Titles wrap to two lines, with full text available on hover. Read and idle are never treated as done. Pending input takes priority over live work. Live work stays under Working; completion marks distinguish idle unread and read chats.

Rows retain read/unread, pin, rename, split, archive, and host-confirmed delete controls. Decision and other status indicators stay at the trailing edge, including on hover and while jump shortcuts appear. The green archive suggestion is a direct action: Tidy rechecks completion, then the next parent in status/project order opens after successful archiving. At the end, the previous parent opens; with no parent remaining, the project's new-chat screen opens. A failed archive keeps the current chat open with a visible error. Each chat header has a project pill, including split panes and compact layouts. Numbered jump shortcuts, middle-click links and split drags retain the host's contracts. Rows are windowed so only a bounded set renders at once.

Archive and decision groups consume the existing Tidy and Decisions sidebar row statuses. Those plugins and their row-marker settings must remain enabled to expose their marks. The plugin does not interpret message text, call AI services, run agents, or archive chats automatically.

## Development

Requires Omnyo 0.46.0 or later and Plugin SDK 0.6.37 or later. Use pnpm.

Run both E2E scripts only against a separate test Omnyo instance with the plugin installed. Set `OMNYO_TEST_URL` to that instance before running them.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
omnyo plugin build .
OMNYO_TEST_URL="${OMNYO_TEST_URL:?Set OMNYO_TEST_URL to the separate test Omnyo instance}" pnpm test:e2e evidence/project-groups-actions
OMNYO_TEST_URL="${OMNYO_TEST_URL:?Set OMNYO_TEST_URL to the separate test Omnyo instance}" pnpm test:e2e:workflows evidence/workflow-activity
```

The workflow E2E checks queued/running work, multiple runs, live completion, progress read failures and descendant activity. A failed or pending progress read suppresses Ready for the affected chat tree. The Status view uses the existing per-origin workflow read API, with six concurrent local reads, a 4–8 second refresh for known work and a 30–32 second sweep for other origins. Thread status changes and reconnects reconcile immediately. No provider or AI calls are made.

The main E2E script uses headless Google Chrome against the separate test Omnyo instance. It verifies the installed toggle and project pill, then uses controlled browser responses to check primary sections, the seven-status order, shared project groups, indicator alignment, collapse behavior, nested chats, navigation, counts, scroll context and compact expansion. Both sidebar and Tidy header archive actions are exercised with delayed success and rejection responses; archive/read writes are intercepted so real chats are never archived. Pass an evidence directory to retain separate runs. Current screenshots and the repeatable receipt are in `evidence/project-groups-actions/`. Earlier evidence stays in `evidence/`.

The plugin supports local path installation in a test Omnyo instance. Before disabling or removing the selected plugin, select `thread-list/thread-list` to keep the sidebar available. No remote publication is performed.
