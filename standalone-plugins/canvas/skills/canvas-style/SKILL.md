---
name: canvas-style
description: Design or refine an Omnyo Canvas dashboard, flow, or visual workspace for readable hierarchy, question-led islands, bento layouts and restrained styling. Use before composing a dashboard or when an agent needs help polishing Canvas content.
---

# Canvas styling specialist

Shape a readable visual argument from the existing evidence. Keep the board's useful structure and the owner's manual edits. Work through the existing Canvas tools and the installed [Canvas skill](../canvas/SKILL.md); use normal agent delegation when a separate styling pass helps. This skill adds no model runtime, API calls, schedules, provider spend, or release authority.

## Inspect before composing

Read the board with `canvas_show`; its outline lists islands, their questions and members. Inspect the relevant modules, current selection, authored views and render reports. Review the actual render when visual evidence is available. Distinguish a current render from stale or missing evidence. Keep source data, units, dates, populations and uncertainty beside the claims they support.

## Plan the map before placing anything

1. **Write the questions.** List the three to six questions the board answers, in the order a reader asks them. Each becomes one island: a short name of one to three words ("Discovery") and the question as its heading ("How do people find us?").
2. **Group by question, not by source or chart type.** A PostHog chart and a Search Console table that answer the same question share an island. Two charts from one provider that answer different questions do not.
3. **Order by the reading path.** Put the first question top left. Follow cause before effect, overview before detail. Give the island most readers need first the most space.
4. **Lead once.** One board-level lead module states the overall takeaway above the islands. Each island may have one lead module, its strongest evidence.
5. **Quiet the rest.** Goal, status, sources, limits and proof go in a final island with `surface: "none"` and quiet emphasis.

An island holding one module is a heading, not an area: merge it into a related island. An island with more than eight to ten modules answers several questions: split it.

## Bento patterns

Bento islands use aligned tracks. A module's `span` sets its width; content sets its height. Each row should fill its columns, and short modules belong in a stack beside a tall one.

| Pattern              | Shape                                                                  | Use                                               |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| Headline strip       | `columns: 3`, three metrics with span 1                                | Opening numbers for one question                  |
| Trend and reading    | chart `span: 2`, then a `column` stack of a metric and a short finding | The default for a chart that needs interpretation |
| Evidence and context | table `span: 2`, stack of notes beside it                              | A lookup table with what to notice                |
| Comparison pair      | `columns: 2`, two charts span 1, shared note `span: 2` below           | Two windows or cohorts side by side               |
| Full-width detail    | one module with `span` equal to `columns`                              | A long table or timeline closing the island       |

A typical island combines two patterns: a headline strip, then a trend and reading row.

```json
{
  "id": "discovery",
  "flow": "bento",
  "columns": 3,
  "island": { "title": "Discovery", "question": "How do people find us?", "accent": "blue" },
  "children": [
    { "node": "clicks" },
    { "node": "impressions" },
    { "node": "ctr" },
    { "node": "search-trend", "span": 2, "emphasis": "lead" },
    {
      "id": "search-reading",
      "flow": "column",
      "children": [{ "node": "search-finding" }, { "node": "search-caveat" }]
    }
  ]
}
```

Arrange islands with a `row` (weights by importance) or a `column` of rows. Let a narrower island sit beside a stack of two smaller islands rather than leaving open sea under it. Uneven island heights are fine; they give the map its silhouette.

## Size and spacing

- Match the composition width to the map: about 3200 pixels for three islands per row, 2000–2400 for two per row and about 1200 for a single column. Wide maps fit wide screens; when zoomed out, readers see every island as a labelled region.
- Give a three-column bento island at least 700 pixels. Tracks stay at least 200 pixels wide and drop automatically on narrow screens.
- Leave gaps at their defaults: 20 pixels inside bento, 56 between islands. Proximity carries the grouping, so do not add borders or boxes to separate modules.
- Size modules to their content. Never add fixed heights, internal scrolling or spacer modules to even out a row; restack instead.

## Color

- Give each island one accent from `blue`, `teal`, `violet`, `rose` and `amber`, distinct from its neighbours. Use `neutral` for meta islands. Prefer blue, teal and violet for ordinary areas; reserve rose and amber for areas about cost or risk so they do not read as alarms.
- Accents identify areas. Tone (`positive`, `warning`, `negative`) carries status. Do not use an accent to mean good or bad.
- In HTML, color series with `var(--canvas-accent)`, `canvas-line`, `canvas-area` and `canvas-bar`. Hard-coded colors break the island's identity, its dark theme and later recolors. Draw a second series in a neutral or muted color.
- Keep every essential distinction readable without color: labels, position and direct annotation come first.

## Type and copy

- The island name is a short label; the question is its heading. Module titles state the finding ("Clicks grew sixfold in October"), not the metric name ("Clicks").
- Show prominent measured values, quiet axes and concise captions. Keep values aligned and units consistent.
- State provenance once per island in a quiet note when its modules share a source window. Repeat it on a module only when that module differs.
- Choose chart forms from the question: a line for change, bars for magnitude, a table for exact lookup, a diagram for relationships.
- Never invent data, imply conversion between different cohorts, or turn correlation into cause. Islands next to each other are not a funnel.

## Avoid

- One-module islands, more than eight islands, or islands grouped by data source.
- Boxes, borders, shadows or backgrounds inside HTML modules; the island already provides the surface.
- Ornamental gradients, decorative badges, icons without meaning and oversized empty headings.
- Dropdowns or accordions that hide primary comparisons. Readers explore by panning and zooming; reserve filters for genuinely large datasets.
- Whole-board rewrites for local polish. Rearrange one island with `canvas_compose({"island": ...})`.

## Author semantic views

Keep primary charts visible at overview scale. Author `overview` only when a simplified chart or other useful visual summary uses a similar height to the evidence. A tiny claim or a few values inside a large evidence slot makes the board look empty. Omit that overview and keep the evidence visible; put short interpretations in adjacent annotation modules. Keep evidence readable at normal scale. Source views retain the primary evidence and add definitions or provenance.

At overview zoom the island names and questions become map labels, so the islands carry the overview. Use authored views of the same module, not unrelated content at each zoom level. Preserve landmarks and camera position. Canvas reserves the maximum view footprint and keeps frames mounted.

## Finish with the render

1. Read the `notes` returned by `canvas_compose`. Fix each one or keep a deliberate, explained exception.
2. Open Canvas, then run `canvas_verify({"island": "<id>"})` for every island. Resolve `Uneven row`, overlap and overflow issues by restacking, changing spans or moving a module. A missing or stale report is a visible verification limit, not a pass.
3. Inspect captures at three scales. When zoomed out, labels are legible and island shapes are distinct. At 100%, the hierarchy reads top left to bottom right and charts carry the accent. At 390 pixels wide, the compact outline shows island sections in reading order.
4. Check the evidence trail after a source refresh, and confirm that manual moves and edits survived.

Report the specific islands and modules changed and the evidence checked. Stop once the requested composition is readable and the targeted changes are verified.
