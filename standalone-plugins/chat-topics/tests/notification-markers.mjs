import assert from "node:assert/strict";

const DOT_KINDS = ["need", "blk", "run", "que", "done", "idle", "ext"];

export async function assertNotificationMarkers(page, list) {
  const snapshot = () =>
    list.locator(".ct-row").evaluateAll(async (rows) => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

      const context = document.createElement("canvas").getContext("2d", {
        willReadFrequently: true,
      });

      const rgba = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "rgba(0, 0, 0, 0)";
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);

        return [...context.getImageData(0, 0, 1, 1).data];
      };

      return rows
        .filter(
          (row) =>
            row.getBoundingClientRect().height > 0 &&
            row.querySelector(".ct-row-link")?.dataset.sidebarThreadId !== undefined,
        )
        .map((row) => {
          const link = row.querySelector(".ct-row-link");
          const dot = link.firstElementChild;
          const style = getComputedStyle(row);
          const titleStyle = getComputedStyle(row.querySelector(".ct-row-title"));
          const unread = row.dataset.unread === "true";

          const interactive =
            row.matches(":hover, :focus-within") || row.querySelector(":hover") !== null;

          return {
            id: link.dataset.sidebarThreadId,
            state: row.dataset.state,
            opacity: style.opacity,
            active: row.dataset.active === "true",
            asking: row.dataset.asking === "true",
            unread,
            linkUnread: link.dataset.unread === "true",
            interactive,
            height: row.getBoundingClientRect().height,
            meta: row.querySelector(".ct-row-meta, .ct-row-meta-text") !== null,
            dot:
              dot !== null && dot.classList.contains("ct-dot")
                ? {
                    kind: dot.dataset.dot ?? null,
                    role: dot.getAttribute("role"),
                    label: dot.getAttribute("aria-label"),
                  }
                : null,
            shadow: style.boxShadow,
            background: rgba(style.backgroundColor),
            title: titleStyle.color,
            titleWeight: titleStyle.fontWeight,
            foreground: style.color,
          };
        });
    });

  const assertRows = (rows) => {
    for (const row of rows) {
      assert.equal(row.opacity, "1", `${row.id}: rows stay opaque, so the running dot stays crisp`);
      assert.ok(row.dot !== null, `${row.id}: the row link leads with a state dot`);
      assert.ok(DOT_KINDS.includes(row.dot.kind), `${row.id}: the dot names a known state`);
      assert.ok(
        row.state === "shelf" ||
          row.dot.kind === row.state ||
          (row.state === "que" && row.dot.kind === "run"),
        `${row.id}: the dot shows the row state`,
      );
      assert.equal(row.dot.role, "img", `${row.id}: the dot is an image`);
      assert.ok((row.dot.label ?? "").length > 0, `${row.id}: the dot has a label`);
      assert.equal(row.meta, false, `${row.id}: the row has no description line`);
      assert.ok(row.height <= 34, `${row.id}: one line per chat`);
      assert.equal(row.unread, row.linkUnread, `${row.id}: row and link agree on unread`);
      assert.equal(row.shadow, "none", `${row.id}: no edge bar or outline`);

      if (row.active) {
        const [red, green, blue, alpha] = row.background;

        assert.equal(row.unread, false, `${row.id}: the open chat counts as read`);
        assert.ok(
          alpha > 0 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 8,
          `${row.id}: the open chat has the soft neutral accent fill`,
        );
        assert.notEqual(row.titleWeight, "650", `${row.id}: bold is reserved for unread chats`);
      } else if (!row.interactive && row.asking)
        assert.ok(
          row.background[3] > 0,
          `${row.id}: a running chat that asks has the attention tint`,
        );
      else if (!row.interactive)
        assert.equal(row.background[3], 0, `${row.id}: a resting row that is not open has no fill`);

      if (row.unread) {
        assert.equal(row.titleWeight, "650", `${row.id}: an unread title is bold`);

        if (row.state !== "run")
          assert.equal(row.title, row.foreground, `${row.id}: an unread title uses the foreground`);
      }

      if (row.state === "run" && !row.active)
        assert.notEqual(row.title, row.foreground, `${row.id}: a running title is muted`);
    }
  };

  const initial = await snapshot();
  assert.ok(initial.length > 0, "The real Chat Topics component must render rows");
  assertRows(initial);

  for (const state of ["need", "done", "run"]) {
    const sample = initial.find((row) => row.state === state);

    if (sample === undefined) continue;
    await list.locator(`[data-sidebar-thread-id="${sample.id}"]`).hover();
    assertRows(await snapshot());
  }

  await page.mouse.move(1000, 450);

  return initial.map(({ id, state, active, unread }) => ({ id, state, active, unread }));
}
