# Inline UI

Native React blocks, HTML visualizations and Markdown document previews inside Omnyo messages, with consistent assistant typography. Native charts inherit Omnyo's theme and need no HTML file or external library.

Supported message directives: `status-table`, `file-card`, `metric-row`, `mini-chart`, `comparison-bars`, `ordered-steps`, `callout`, `inline-badge`, `progress`. Place each on its own line and interleave normal Markdown. See [the native-block skill](skills/inline-ui/SKILL.md) for exact syntax. HTML and Markdown previews use the bundled [inline-vis skill](skills/inline-vis/SKILL.md).

Agent instructions ask for glanceable replies by default: the answer first in bold, then status tables for results and scope, file cards for deliverables and at most one callout for the required action. Proposed UI, layout or interaction designs appear as an inline mockup or clickable prototype in the same reply, before any question about them.

Status tables color each value by meaning (positive, warning, negative, info, muted or neutral). File cards resolve local paths against the containing message's machine/workspace, check that the file exists there, and use Omnyo's semantic file link to open the preview. A missing file shows **File not found** with the checked path, no link and no plan actions; cards check again when the window regains focus. Web URLs use Omnyo's Markdown renderer. Unavailable file locations stay visibly unavailable instead of navigating to a website path.

Comparison bars keep full category names and exact numbers visible, with an optional second series on the same scale. Ordered steps show a neutral flow or explicitly supplied states. Neither block infers measurements or completion.

Assistant text gets clearer paragraph/list spacing, heading hierarchy, tables, inline code and blockquotes. User messages, composer inputs, file previews and syntax token colors retain their existing styles. Disabling the plugin removes the typography changes.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test:e2e -- --output /absolute/owned-proof-directory
omnyo plugin build
omnyo plugin install . --yes
```

The SDK version matches the installed Omnyo scaffold; its exact package version is the sole exception to the seven-day dependency age rule. Other dependency versions meet that rule. No remote repository, publication, provider changes or additional paid service.

## Plan actions

Whenever you create or update a saved plan document, include a `file-card` with its actual local Markdown path. When the Pursue plugin is installed and running, it reads the content and ownership before offering actions. Only implementation-ready plans with remaining executable work and acceptance checks show the model picker and **Execute**. Finished plans show **Completed**; exhausted progress shows **No remaining steps**. Linked live owners show **Running** with **Open run**. Manual execution without a linked owner shows **In progress**, never a new Execute action. Required gates show **Blocked**; an unfinished idle run shows **Stopped** with **Open run**. Ambiguous starts retain **Check run**. Ordinary documents and web links keep their file-opening behavior. These rules apply to existing cards, including fences. Execute preserves current authority and spending gates.

Cards for the same plan in one chat share a single check. A card keeps its actions on screen while it refreshes, so the first click always lands. It updates by itself when its run starts, stops or finishes, and ignores unrelated chats.

Without Pursue, file cards show no plan actions and no error. Pursue owns reads, content validation, defaults, execution and recovery. Inline UI does not run a plan while rendering a card. Saved ExecPlans should always be returned as a file card with the actual local path. Settings → Pursue → Plan execution defaults controls automatic or fixed model selections. Ordinary files and web links keep their existing behavior.

## HTML and Markdown previews

Inline UI 0.4.0 includes the original Inline Visualizations renderer. Existing
`inline-vis` fences and directives keep their syntax and render alongside native
blocks in the same plugin. A fenced block contains a self-contained HTML page:

````text
```inline-vis
<div>A visualization</div>
```
````

A directive reads a source-relative HTML or Markdown file from the current
workspace or the thread's storage:

```text
::inline-vis{file="charts/out.html"}
::inline-vis{file="reports/summary.md"}
::inline-vis{source="thread-storage" file="reports/result.html" height="480"}
```

Files must be UTF-8 text, at most 5 MiB. Relative assets resolve beside the HTML
file. HTML remains inside an opaque-origin `allow-scripts` sandbox, with the
existing theme, content-height, scroll-input and user-clicked HTTP(S) link
bridges. Markdown keeps Omnyo's document renderer, copy, expand and sidebar
preview actions. Unclosed or empty fences retain their original code.

## Credits

The HTML and Markdown renderer comes from the
[inline-vis plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/inline-vis),
created by Michael Yong and the bb contributors and extended by Omnyo. The
original MIT copyright and permission notice are preserved in [LICENSE](LICENSE)
and the attribution in [NOTICE](NOTICE).
