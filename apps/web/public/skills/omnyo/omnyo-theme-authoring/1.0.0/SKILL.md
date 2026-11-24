---
name: omnyo-theme-authoring
description: Design an Omnyo color theme from documented tokens and verify light and dark rendering with an offline preview option.
license: MIT
---

# Omnyo theme authoring

Use this skill to create a color theme for a documented compatible Omnyo version. It includes an offline palette method; it does not bundle Omnyo, Theme Preview, or an authoritative token schema.

## Confirm the theme contract

Before integration, obtain the installed version's public theme documentation. Confirm supported tokens, selectors, value syntax, discovery location, activation procedure, and whether a compatible Theme Preview tool is installed and authorized for use. Do not infer those details from this skill's examples or invent commands.

If the public contract is missing, prepare an offline CSS palette and preview instead. Label it a design candidate. Do not place it in runtime directories or claim it is installable.

For an existing theme, read its current CSS and preserve unrelated choices. Separate color changes from typography, spacing, and layout changes. A request to change a palette does not authorize restyling adjacent controls.

## Design by role

Start with canvas, primary text, secondary text, accent, selected surface, border, focus, success, warning, and error roles. Record where each foreground appears and its actual background. Derive related tones from the anchors, then inspect the combinations rather than trusting color names.

Keep light and dark palettes distinct. Do not derive dark mode by blindly inverting light colors. Maintain state differences without relying only on hue; a selected item and a warning need distinguishable treatment when viewed without color.

The following original `Juniper` fixture is ordinary CSS for an offline HTML preview. Its `--demo-*` names are deliberately not Omnyo API tokens:

```css
:root {
  --demo-canvas: #f3f5ed;
  --demo-ink: #20362d;
  --demo-accent: #316548;
  --demo-selected: #dbe8d4;
}

[data-mode="dark"] {
  --demo-canvas: #17241f;
  --demo-ink: #e3ecdc;
  --demo-accent: #a5d2aa;
  --demo-selected: #304b3b;
}

.demo-page {
  color: var(--demo-ink);
  background: var(--demo-canvas);
}

.demo-link {
  color: var(--demo-accent);
}

.demo-selected {
  background: var(--demo-selected);
}
```

Create a local preview with body text, a link, a selected row, a button, a focused input, and status messages. Use synthetic text, including long labels. Toggle the preview's `data-mode` value to inspect both palettes. These swatches are a starting point, not a verified accessibility result.

## Adapt and measure

Map each chosen role to the target version's documented token. Keep a short role-to-token table so an unsupported role stays visible. Do not silently substitute a similarly named token whose meaning differs. Prefer documented derivation mechanisms to scattered hard-coded overrides. Avoid broad element selectors that change content outside the theme contract.

Measure foreground/background contrast in the rendered states. For WCAG AA checks, use at least 4.5:1 for ordinary text and 3:1 for large text; apply the relevant 3:1 requirement to meaningful control boundaries and indicators. Contrast checks alone do not establish complete accessibility. Inspect keyboard focus, disabled and selected states, status labels, and images as well.

If a compatible Theme Preview is available, use its documented views to inspect the resolved tokens and representative surfaces. Verify the actual application after activation in an authorized test profile. Save the prior selection so it can be restored. Do not change a user's active theme merely to generate evidence.

## Finish

Return the CSS, target version, role mapping, and measured combinations with the test method. Distinguish offline preview, compatible preview-tool results, and actual app rendering. Record unsupported tokens or untested surfaces. A valid stylesheet or attractive screenshot does not establish cross-version compatibility or whole-app accessibility.
