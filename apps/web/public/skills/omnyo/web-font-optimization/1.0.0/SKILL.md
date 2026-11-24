---
name: web-font-optimization
description: Reduce web font downloads while checking character coverage, layout, and rendering against a fixed baseline.
license: MIT
---

# Web Font Optimization

Reduce the bytes a browser downloads for typography without silently changing the site's appearance. Use this for a font delivery or subsetting task, not a typography redesign.

## Establish what must stay the same

Record the source revision, representative routes, browser and OS versions, viewport, device scale, locale, theme, and cache conditions. Save the original font assets and their licenses. Confirm that the license permits modification and redistribution; obey any reserved font-name requirements before renaming a modified face.

Inventory each face's family, weight, style, stretch, variable axes, byte size, hash, Unicode mappings, shaping features, and hinting. Inspect both authored CSS and generated CSS. Check computed styles on real text: a family name in a stylesheet does not establish that the browser used that face.

Create a usage manifest from visible content, translations, component states, generated labels, pseudo-elements, and dynamic-content requirements. For example:

```json
{
  "family": "Example Sans",
  "styles": ["normal", "italic"],
  "weights": [400, 600],
  "requiredText": ["Cafe\u0301", "£12.50", "office → settings"],
  "dynamicCoverage": "Latin names supplied by users",
  "preserve": ["kerning", "ligatures", "mark positioning"]
}
```

This is a synthetic manifest, not a complete language repertoire. Include combining marks, currencies, punctuation, soft hyphens, and content produced by CSS. State which future text is outside the contract. Do not assume that a single captured page covers user-entered names or every translation.

## Choose and generate a candidate

Use the project's existing tooling where possible. For a portable local workflow, fontTools can inspect, instantiate, and subset fonts; its WOFF2 support needs the appropriate compression dependency. Check the installed version and command help before selecting options. Record versions and exact commands in the result.

Start with the least invasive change: remove an unused face or preload only when usage evidence supports it. For a subset, retain shaping dependencies, required default features, and the contracted character repertoire. Narrow a variable axis only after accounting for responsive styles, animation, optical sizing, and local overrides. Treat dropping hinting as a separate experiment with its own visual comparison.

If splitting a face into common and less frequent characters, derive CSS `unicode-range` values from actual output mappings. Preserve the original ownership of characters across faces. Avoid broad ranges that promise missing glyphs. Reopen every generated file and verify its tables, metrics, axes, and coverage; process exit status is insufficient.

Keep generation reproducible: use fixed input hashes and options, run it twice, and compare output hashes. Preserve an understandable regeneration command. Do not add font processing to an existing build automatically when a checked-in asset workflow already fits the project.

## Integrate and check

Keep `font-display`, fallback families, synthesis settings, and descriptors unchanged unless the task explicitly includes loading-policy changes. Match preloads to the actual URL, type, and CORS mode. Inspect bundled face ordering and check that a fallback face does not win for extended characters.

For each selected route and text fixture:

1. Capture baseline and candidate with identical content and rendering conditions. Wait for the intended faces to load and confirm their use.
2. Compare element dimensions and line breaks, then compare screenshots. Preserve the original images and a difference image. Report changed pixels and their locations; do not hide text regions or increase a threshold to obtain a pass.
3. Check cold-cache requests and transferred bytes separately from on-disk sizes. Also check warm-cache behavior. Count a reused font URL once per navigation.
4. Exercise a common-character page and an extended-character page. Confirm the conditional file loads only when its characters are needed.

Test the engines and platforms relevant to the site. A Chromium result establishes Chromium behavior under those conditions, not Safari or every OS. If rendering changes, isolate the option responsible and retain the appearance-preserving version unless that tradeoff is authorized.

## Deliver

Provide a per-face before/after byte table, per-route network totals, tested environments, coverage limits, layout and pixel findings, and the regeneration command. Distinguish file savings from transfer savings. Link the actual comparison evidence. Name any retained data, such as hinting or a wider axis, and the byte cost. Publish only within the user's existing authority.
