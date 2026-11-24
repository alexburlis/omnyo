import assert from "node:assert/strict";
import { test } from "vitest";
import { HIGHLIGHT_CSS, OWNED_ROW_PRESENTATION } from "./highlight-css.js";

const ROW_CLASS = ".omnyo-sidebar-hover-actions-row";

test("every painted row selector steps aside for rows that own their presentation", () => {
  const rowSelectors = HIGHLIGHT_CSS.split(ROW_CLASS).slice(1);
  assert.ok(rowSelectors.length > 10);

  for (const rest of rowSelectors)
    assert.ok(
      rest.startsWith(`:not(${OWNED_ROW_PRESENTATION})`),
      rest.slice(0, 80),
    );
});

test("rows without the opt-out keep the legacy rail, tint and dimming rules", () => {
  for (const state of [
    "unread-success",
    "unread-failed",
    "needs-input",
    "working",
    "callback",
  ])
    assert.ok(HIGHLIGHT_CSS.includes(`[data-needs-you="${state}"]`), state);
  assert.match(
    HIGHLIGHT_CSS,
    /--tw-inset-shadow: inset var\(--needs-you-rail-width\)/u,
  );
  assert.match(
    HIGHLIGHT_CSS,
    /background-image: linear-gradient\(var\(--needs-you-tint\)/u,
  );
});
