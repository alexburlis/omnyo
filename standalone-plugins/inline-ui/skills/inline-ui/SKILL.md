---
name: inline-ui
description: Compose glanceable Omnyo chat replies with native status tables, file cards, metrics, charts, comparison bars, ordered steps, callouts, progress bars and badges, with short prose between blocks.
---

The reader is a busy owner deciding between many chats. They should get the answer from a two-second scan. Every substantive reply follows this shape:

1. **Answer first.** One plain sentence with the result or the decision needed, key words in bold.
2. **Structure, not paragraphs.** Put results, changes, checks, scope and risks in a `status-table`; numbers in a `metric-row`; sequences in `ordered-steps`.
3. **Images inline; other deliverables as cards.** Render images inline by default with native click-to-open previews. Other files, reports, previews, plans and downloads get a `file-card`.
4. **One callout at most**, for the thing the reader must act on.
5. **Say each fact once.** Prose between blocks is one or two short sentences. Bold the lead term of list items.

A one-line answer stays plain text. Use the `inline-vis` skill for diagrams, mockups or anything these blocks cannot show.

Text inside a block is plain: Markdown, links and `@thread` mentions show literally, so put them in ordinary Markdown beside the block. A status-table row holds one label, one value and an optional detail; when rows need links, mentions or more cells, use a Markdown table instead. Never emit an empty or placeholder block to fit this shape.

Emit directives on separate lines, outside code fences. Write each directive as one complete line that ends with the closing quote and brace (`"}`): a line break inside the braces or a missing brace shows the raw source instead of the block. A directive has no body and no closing `::` line; a callout's or badge's words go in `text="…"`. A block's caption is `label`; only `callout` and `file-card` take `title`. Quotes inside a value are fine, written plainly, as `\"`, as `&quot;` or as curly quotes (`“…”`): `labels="\"Load failed\" fix|Relay"` renders `"Load failed" fix`. Data lives directly in the message; no files, server, extra tools or iframe. React renders strings as text. Keep credentials and customer identifiers out of directives. Put dates, units, sources and material uncertainty beside the relevant values. Pipe-delimited text fields cannot contain a literal pipe.

## Example: approval request

This replaces three paragraphs that repeat the scope, cost and policy twice.

**Approve the newsletter launch?** Built and verified; the email sender is created and **paused**.

::status-table{label="Approval covers" columns="Effect|Status" labels="Email sender, API key, DNS and bounce handling|Test emails|Push, CI, merge and deploy example.com|Activate signup" values="Needs approval|Max 5|Needs approval|Needs approval" tones="warning|warning|warning|warning" details="New sending key|2 to the test inbox, 3 to the provider's test addresses||Footer signup with double opt-in"}

::status-table{label="Verified" labels="Build, lint, types|Route and browser checks|Public candidate" values="Passed|Passed|Committed 4c2e127" tones="positive|positive|info"}

::metric-row{labels="Email sends|Fixed cost" values="$0.10 / 1,000|$0.00 / month" details="Published per-email rate|Excludes data transfer and monitoring"}

::file-card{title="Email and form preview" href="/absolute/path/preview.html" meta="Form and three emails"}

::file-card{title="Launch approval scope" href="/absolute/path/launch-scope.md" meta="Exact effects and limits" kind="link"}

## Example: what changed

::status-table{label="What changed" columns="Drop|New behavior" labels="Junk Rare, even Ancestral|Rare with 2+ useful stats|Any Greater Affix|All Legendaries" values="Hidden|Gold|Cyan|Visible" tones="negative|warning|info|neutral"}

Never wrap a directive in a code fence. Only `status-table` and `file-card` fences are read: a two- or three-column Markdown table (✅ ❌ ⚠️ set the tone; a third column becomes the details) or `title:`/`href:`/`meta:` lines. A fence that does not parse shows a warning above its source, and every other fence language stays code.

## Choose the format

| Information                                     | Use                            | Keep beside it                                   |
| ----------------------------------------------- | ------------------------------ | ------------------------------------------------ |
| Results, changes, checks, scope, risks          | `status-table`                 | Tone per value; detail for the reason            |
| An image                                        | Markdown image                 | Native click-to-open preview                     |
| Another file, report, preview, plan or download | `file-card`                    | Short meta line: size, count, date or scope      |
| A few headline quantities                       | `metric-row`                   | Measurement window and units                     |
| One observed series over time                   | `mini-chart`                   | Dates, time zone and missing coverage            |
| Named categories or one benchmark condition     | `comparison-bars`              | Full names and one common unit                   |
| Two conditions measured on the same categories  | Paired `comparison-bars`       | Series names, sample size and measurement limits |
| Ordered stages, a flow or a status sequence     | `ordered-steps`                | Explicit supplied states, timestamp and evidence |
| Quantity toward a known total                   | `progress`                     | Actual numerator and denominator                 |
| Tradeoffs, mixed units or detailed options      | Markdown table                 | Evidence and material uncertainty                |
| Rows with links, mentions or extra columns      | Markdown table                 | One row per item, with links in the cells        |
| One important conclusion                        | `callout` or ordinary Markdown | The reason it matters                            |

## Tones

Every `tone` and `tones` attribute, on any block, uses one vocabulary: `neutral`, `info`, `positive`, `warning`, `negative` or `muted`. Tone by meaning, not decoration: `positive` = passed, done, kept; `warning` = needs approval, pending, partial; `negative` = failed, removed, blocked; `info` = changed, new, reference; `muted` = skipped, unchanged; `neutral` = a plain fact. `success`, `error` and `note` are accepted aliases and render as `positive`, `negative` and `info`. Any other word, such as `danger`, is invalid.

Historical chat evidence stays historical. A queued job is queued; a passing source check does not establish runtime success. Neutral process diagrams omit states. Do not convert a partial checklist, estimated effort or planned work into a completion percentage. Use ordinary Markdown for a simple fact or comparison that needs no visual.

## Status table

A row label and one short colored value per row, with an optional third column for each row's detail. One to twenty rows.

Allowed attributes only: `label`, `columns`, `labels`, `values`, `tones`, `details`, `note`. `labels` and `values` are pipe-delimited with matching counts; label entries <=160, values <=1200; paragraph-length values wrap without truncation. Optional `columns` names two headers, or three when the details get their own column (each <=60); never more. Optional `tones` must match the row count, each one from [Tones](#tones); the default `neutral` shows the value in bold. Optional `details` (<=500 each, blanks allowed) add a muted second line under the row label, or fill the third column when `columns` names one. label<=120, note<=400. Text may contain a bracketed address such as `Support Team <support@example.com>`; an HTML tag such as `<b>` or `<a href=…>` invalidates the whole table. Put command placeholders such as `<id>` inside backticks; a bare `<id>` reads as a tag.

Each attribute is one whole column, and `|` moves to that column's next row: the reverse of a Markdown table, where `|` moves to the next cell. Never write a row's cells one after another; `labels="Build|Passed|Tests|Passed"` is four row names, not two rows. `columns` names the headers only.

Build complete rows first, each with one label, one value, one tone and one detail. Put the row name in `labels` and its explanation in `details`; an explanation is not another label. Then join each field with `|`, preserving row order. Use an empty detail for a row without an explanation. Before sending, count entries: `labels`, `values`, `tones` and `details` must all have the same count. If omitting `tones` or `details`, omit the whole attribute. Fix a mismatch before emitting the directive; never infer pairs from extra labels.

Two opportunities need two labels, two values, two tones and two details:

::status-table{columns="Opportunity|Value" labels="Cache npm downloads for clean consumer installs|Profile slow release checks and setup" values="Best first candidate|Second priority" tones="info|info" details="Concrete gap; current cache covers pnpm only|Find avoidable work in the roughly 10-minute sweep"}

A value states the evidence-backed state; never upgrade it to sound finished.

::status-table{label="Checks" columns="Check|Result" labels="Typecheck|Browser E2E|Device install" values="Passed|71/71 passed|Not run" tones="positive|positive|muted" details="||No device connected"}

## Images

Render image deliverables inline by default with standard Markdown image syntax:

```markdown
![Description](/absolute/path/image.png)
```

Use the actual image path or URL. Omnyo's native image renderer supplies the
click-to-open preview; do not replace it with a file card or text link alone.
Add a separate download link only when useful. Follow an explicit user request
for a different presentation.

## File card

A deliverable link with an icon and a muted meta line. Use one per file; adjacent cards stack.

Link only a file that exists at that exact path on the machine running this chat. Check it there just before sending (`test -e <path>`). A file you read from another branch or ref (`git show origin/main:<path>`), another worktree or another machine is not at that path: link the copy that exists, or name the branch or commit in prose instead. The same rule applies to Markdown file links. A card whose file is missing shows **File not found** with the checked path and offers no link or plan actions.

Whenever you create or update a saved plan document, include a `file-card` with its actual local Markdown path. When the Pursue plugin is installed, it reads the card's plan and adds its execution status; only implementation-ready plans with remaining executable work and acceptance checks show the model picker and **Execute**. Finished plans show **Completed**; exhausted progress shows **No remaining steps**. Linked live owners show **Running** with **Open run**. Manual execution without a linked owner shows **In progress**, never a new Execute action. Required gates show **Blocked**; an unfinished idle run shows **Stopped** with **Open run**. Ambiguous starts retain **Check run**. Without Pursue, plan cards stay ordinary file cards. Ordinary documents and web links keep their file-opening behavior. These rules apply to existing cards, including fences. Execute preserves current authority and spending gates.

Allowed attributes only: `title`, `href`, `path`, `meta`, `kind`. title<=160 and cannot contain `<` or `>`; meta<=200. `href` is an `http(s)://` URL, an absolute path or a workspace-relative path, exactly as you would write it in a Markdown link; Omnyo opens it the same way. `path` is an alias for `href` in both directives and fences; prefer `href` when writing new cards. If both are supplied, they must name the same destination. `kind` is `file` (default), `download` or `link`.

::file-card{title="Download fixed Level 55 loot filter" href="/absolute/path/filter.txt" meta="12 rules · Season 15 · Blazing Scream Warlock" kind="download"}

## Metric row

One to four items. Allowed attributes only: `labels`, `values`, `details`; a metric row has no tones or caption. Pipe-delimited labels/values/details must have matching lengths. Details optional.

::metric-row{labels="Accounts|Weekly visitors|Google clicks" values="46|339|274" details="Oct 11|Oct 4–10 · +8%|Oct 2–8 · +24.5%"}

## Mini chart

Two to eighty finite decimal values, comma-delimited. Optional pipe-delimited labels must match point count. kind="line" (default) or "bar"; tone from [Tones](#tones), default "neutral". label<=120, unit<=40, note<=400. Values must be within +/-1e12. Use observed series; do not insert zeros for unavailable observations. Hover/focus points for exact values; arrow keys/Home/End navigate; expandable data table supplies all values.

::mini-chart{label="Google clicks per full week" values="26,35,91,143,159,203,223,238" labels="Aug 10|Aug 17|Aug 24|Aug 31|Sep 7|Sep 14|Sep 21|Sep 28" kind="bar" unit="clicks" note="Finalized Google web search; weekly dates are Pacific."}

## Comparison bars

One to twelve full category labels, pipe-delimited in `labels`, with matching comma-delimited `values`. Category order is preserved. Exact decimal text stays visible. Signed bars share one zero-inclusive scale; they do not imply a time trend. Arrow keys/Home/End navigate the bars; an expandable data table supplies all values.

Allowed attributes only: `label`, `labels`, `values`, `unit`, `note`, `series`, `values2`, `series2`. label defaults to "Comparison" and is <=120; each category <=120; unit<=40; note<=400; series names<=40. Values are finite decimals within +/-1e12; nonzero decimal underflow is invalid. Single-series `series` defaults to "Values".

::comparison-bars{label="Storage reported on Oct 7" labels="Projects|Library|Omnyo|Temporary files|Colima" values="242.3,184.7,134.1,64.4,45.4" unit="GB" note="Historical logical sizes. Shared APFS blocks mean these are not additive reclaimable totals."}

For paired bars, supply `values2` plus explicit, nonempty, distinct `series` and `series2`. Both series must have the same category count and unit. Use separate blocks or a table for mixed units. `series2` without `values2` is invalid. Keep sample size and unmeasured surfaces in the note.

::comparison-bars{label="Historical backend benchmark" labels="Median rewrite|p90 rewrite|Guard wait" values="383,677,0" series="Old" values2="606,784,289" series2="Prepared" unit="ms" note="Oct 11 report · Frankfurt backend · 10 requests per condition; native insertion and authenticated US latency unmeasured."}

## Ordered steps

One to twelve pipe-delimited `labels` in the supplied order; the attribute is `labels`, never `items`. Each label is a short step name, with any longer instruction in `details`. Omitting `states` produces a neutral numbered sequence. Use that form for a process or plan whose execution status is not supplied.

Allowed attributes only: `label`, `labels`, `details`, `states`, `asof`, `note`, `refs`. label defaults to "Steps" and is <=120; each label<=120; each detail<=500; each ref<=240; asof<=120; note<=400. Optional pipe-delimited `details`, `refs` and `states` must each match the label count. Details and refs may have blank entries. States must be exactly `pending`, `queued`, `running`, `done`, `waiting`, `blocked`, `failed` or `unknown`. States are explicit, with no inferred progress, ETA or completion percentage.

::ordered-steps{label="Coach response flow" labels="Generate|First review|Second review|Reply" note="Ordered processing stages; execution status is not reported."}

Refs are inert plain text, including thread mentions. Put clickable sources in ordinary Markdown immediately beside the block; do not invent thread URLs. Timestamps appear only when supplied. Do not use a historical state as a current live state.

::ordered-steps{label="Example release stages" labels="Source checks|Device check|Publication" states="done|blocked|pending" details="Checks passed|Device unavailable|Awaiting device proof" asof="Illustrative example" note="Example data, not a report of a real release."}

## Callout and badge

Use a callout for an important conclusion or measurement note, not redundant reassurance. A callout is one line: its message goes in `text="…"`, never in lines below the directive, and there is no closing `::`. text<=1200, optional title<=120, tone from [Tones](#tones), default "info". Badge text<=120 with the same tones; a badge renders as a compact leaf block, not inside a sentence.

::callout{title="Measurement note" text="Visitor counts include consented visitors and a 20% eligible sample." tone="info"}

::inline-badge{text="Verified live" tone="positive"}

## Progress

A real quantity toward a known total. value>=0, max>0, value<=max, max<=1e12; max defaults to100. No invented completion percentages. label<=120, optional note<=400.

::progress{label="Checks passed" value="4" max="4"}

Use restrained bold, short paragraphs, whitespace, lists for parallel items and Markdown tables for comparisons. Visuals inherit Omnyo's theme. Rendered strings remain inert, including Markdown punctuation. Status-table, comparison and step text fields reject HTML tags, comments and control characters but accept bracketed email addresses and URLs; callout text can display markup literally. Unknown attributes, incomplete data and invalid input remain visible as escaped source text under a warning that names the problem, such as `Couldn’t show this callout: it has no text`. Correct the input rather than hiding it or silently truncating it. Disabling Inline UI leaves directives literal.
