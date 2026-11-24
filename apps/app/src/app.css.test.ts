import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.css"),
  "utf8",
);

describe("app.css chrome geometry", () => {
  it("owns the shared app chrome row height", () => {
    expect(css).toMatch(/--omnyo-app-chrome-row-height:\s*3rem;/);
  });
});

describe("app.css compact prompt controls", () => {
  it("lets designated controls shrink in both compact containers", () => {
    expect(
      css.match(
        /\[data-promptbox(?:-shell)?\] \[data-promptbox-shrinkable-control\] \{\s*flex-shrink: 1 !important;\s*\}/g,
      ),
    ).toHaveLength(2);
  });
});

describe("app.css selected sidebar row", () => {
  const rule = css
    .match(
      /\.omnyo-sidebar-selected-row:not\(\[data-sidebar-touch-armed="true"\]\),\s*\[data-sidebar-sticky-stack\]\s*\[data-sidebar-sticky-tier\]\.omnyo-sidebar-selected-row:not\(\s*\[data-sidebar-touch-armed="true"\]\s*\)\s*\{([^}]*)\}/,
    )?.[1]
    .replace(/\s+/g, "");

  it("paints a blue tint over an opaque sidebar fill without edge marks", () => {
    expect(rule).toContain(
      "--omnyo-sidebar-selected-tint:color-mix(inoklab,var(--timeline-accent)22%,transparent);",
    );
    expect(rule).toContain(
      "background-image:linear-gradient(var(--omnyo-sidebar-selected-tint),var(--omnyo-sidebar-selected-tint)),linear-gradient(var(--sidebar-accent),var(--sidebar-accent));",
    );
    expect(rule).not.toContain("box-shadow");
  });
});

describe("app.css sidebar drag cursor", () => {
  it("scopes the grabbing cursor to the sidebar panel on fine pointers only", () => {
    expect(css).not.toMatch(/body\[data-sidebar-dragging="true"\]\s*\*/);

    const block = css.match(
      /@media \(pointer: fine\) \{\s*body\[data-sidebar-dragging="true"\],\s*body\[data-sidebar-dragging="true"\] \[data-sidebar="panel"\] \* \{([^}]*)\}/,
    )?.[1];

    expect(block).toBeDefined();
    expect(block).toMatch(/cursor:\s*grabbing !important;/);
  });
});
