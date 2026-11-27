import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { assertNotificationMarkers } from "./notification-markers.mjs";

const J_STATES = ["need", "blk", "run", "wait", "done", "idle"];

const J_MARK = {
  need: "need",
  blk: "blk",
  run: "run",
  wait: null,
  done: null,
  idle: null,
};

const UNREAD_J_STATES = ["need", "blk", "done"];

const UNREAD_STATES = ["done", "run", "need"];

const UNREAD_DOT = '<span class="ct-unread-dot" aria-hidden="true"></span>';

async function assertUnreadGutter(page, rowSelector, partSelectors) {
  const rows = await page.locator(rowSelector).evaluateAll(
    (elements, parts) =>
      elements.map((row) => {
        const left = (selector) =>
          row.querySelector(selector)?.getBoundingClientRect().left ?? null;

        const unreadDot = row.querySelector(".ct-unread-dot")?.getBoundingClientRect() ?? null;

        return {
          id: row.querySelector("a")?.getAttribute("href"),
          parts: parts.map(left),
          lead: left(parts[0]),
          unreadRight: unreadDot?.right ?? null,
        };
      }),
    partSelectors,
  );

  const [first] = rows;

  assert.ok(
    rows.some((row) => row.unreadRight !== null),
    `${rowSelector}: sample has unread rows`,
  );

  for (const row of rows) {
    assert.deepEqual(row.parts, first.parts, `${row.id}: unread rows keep the read row columns`);

    if (row.unreadRight !== null)
      assert.ok(row.unreadRight <= row.lead, `${row.id}: the unread dot leads the row's mark`);
  }
}

function jRow(state, active) {
  const id = `j-${state}-${active}`;
  const answers = state === "need";
  const unread = !active && UNREAD_J_STATES.includes(state);
  const mark = J_MARK[state];

  const project =
    mark === null
      ? '<span class="ctf-row-project" aria-hidden="true"><span class="ctf-row-project-icon"></span></span>'
      : `<span class="ctf-row-project" data-mark="${mark}" aria-hidden="true"><span class="ctf-row-project-icon"></span><span class="ctf-row-mark" data-dot="${mark}">${mark === "run" ? '<svg class="ctf-row-mark-spin" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.2A3.8 3.8 0 1 1 1.2 5"></path></svg>' : ""}</span></span>`;

  const reply = answers
    ? '<div class="ctf-reply"><p class="ctf-reply-ask">Pick the release scope</p><div class="ctf-reply-row"><button type="button" class="ctf-button" data-approve="">Approve</button><button type="button" class="ctf-button">Send</button></div></div>'
    : "";

  return `<div class="ctf-row" data-feed-row="${id}" data-state="${state}" data-unread="${unread}" data-active="${active}" data-cursor="${active}"><div class="ctf-row-surface"><div class="ctf-row-main"><a class="ctf-row-link" href="#${id}" data-unread="${unread}" aria-label="${id}. Kind. Verb: The reason">${unread ? UNREAD_DOT : ""}${project}<span class="ctf-title">${id}</span></a>${answers ? '<button type="button" class="ctf-act" data-reply-toggle="" aria-expanded="true">Reply</button>' : ""}<div class="ct-rail" data-kids="false"><span class="ct-rail-age"><time class="ct-age">4h</time></span><span class="ct-rail-end"></span></div></div>${active ? "" : reply}</div></div>`;
}

const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const css = await readFile(process.argv[2] ?? new URL("../app.css", import.meta.url), "utf8");

  for (const width of [200, 280, 360]) {
    for (const working of [false, true]) {
      await page.setContent(
        `<style>* { box-sizing: border-box; } body { width: ${width}px; margin: 0; } ${css}</style><main data-omnyo-plugin="chat-topics"><div class="ctf-kids-list"><div class="ctf-kid-row" data-active="true"><a class="ctf-kid" href="#child"><span class="ct-dot" data-dot="need"></span>${working ? '<span class="ct-dot" data-dot="run" data-agents="2"></span>' : ""}<span class="ctf-kid-title">Ordinary child title with enough text to truncate</span></a><div class="ct-rail"><time class="ct-age">2d</time></div></div></div></main>`,
      );
      await page.locator(".ctf-kid").focus();

      const bounds = await page.locator(".ctf-kid").evaluate((link) => {
        const row = link.getBoundingClientRect();
        const title = link.querySelector(".ctf-kid-title").getBoundingClientRect();

        const dots = [...link.querySelectorAll(".ct-dot")].map((dot) => {
          const rect = dot.getBoundingClientRect();

          return { right: rect.right, center: rect.y + rect.height / 2 };
        });

        return {
          row: { top: row.top, bottom: row.bottom },
          title: {
            top: title.top,
            bottom: title.bottom,
            left: title.left,
            right: title.right,
            center: title.y + title.height / 2,
          },
          dots,
          right: row.right,
        };
      });

      assert.ok(
        bounds.title.top >= bounds.row.top && bounds.title.bottom <= bounds.row.bottom,
        `child title stays inside its row at ${width}px, working=${working}`,
      );
      assert.ok(
        bounds.title.left >= bounds.dots.at(-1).right,
        `child title follows every status dot at ${width}px, working=${working}`,
      );
      assert.ok(
        bounds.title.right <= bounds.right,
        `child title truncates inside its link at ${width}px`,
      );

      for (const dot of bounds.dots)
        assert.ok(
          Math.abs(dot.center - bounds.title.center) <= 1,
          `child indicators and title share one line at ${width}px, working=${working}`,
        );
    }
  }

  const states = ["run", "que", "need", "blk", "idle", "done", "ext"];

  const rows = states.flatMap((state) =>
    [false, true].map((active) => {
      const id = `${state}-${active}`;
      const unread = !active && UNREAD_STATES.includes(state);

      return `<div class="ct-row" data-state="${state}" data-active="${active}" data-unread="${unread}"><a class="ct-row-link" href="#${id}" data-sidebar-thread-id="${id}" data-unread="${unread}"><span class="ct-dot" data-dot="${state}" role="img" aria-label="${state}" title="${state}"></span>${unread ? UNREAD_DOT : ""}<span class="ct-row-title">${id}</span></a></div>`;
    }),
  );

  await page.setContent(
    `<style>:root { color-scheme: dark; --foreground: #e5e5e5; --background: #151515; --muted: #2a2a2a; --muted-foreground: #999; --accent: #333; --success: #20ad66; --destructive: #f54b4b; --attention: #d8a431; --warning: #ef8a4a; --timeline-accent: #79a9db; } *, ::before, ::after { box-sizing: border-box; } body { margin: 20px; width: 280px; background: #222; } ${css}</style><main data-omnyo-plugin="chat-topics">${rows.join("")}</main>`,
  );
  await assertUnreadGutter(page, "main > .ct-row", [".ct-dot", ".ct-row-title"]);
  await page.locator("main").evaluate(
    (main, markup) => {
      const feed = document.createElement("aside");

      feed.className = "ctf";
      feed.innerHTML = markup;
      main.append(feed);
    },
    J_STATES.flatMap((state) => [false, true].map((active) => jRow(state, active))).join(""),
  );

  await assertUnreadGutter(page, ".ctf-row", [".ctf-row-project", ".ctf-title"]);

  const titleWeights = () =>
    page.locator(".ct-row, .ctf-row").evaluateAll((rows) =>
      rows.map((row) => ({
        id: row.querySelector("a").getAttribute("href"),
        unread: row.dataset.unread === "true",
        weight: getComputedStyle(row.querySelector(".ct-row-title, .ctf-title")).fontWeight,
      })),
    );

  for (const row of await titleWeights())
    assert.equal(row.weight, row.unread ? "650" : "400", `${row.id}: only unread titles are bold`);

  await page.locator('[data-unread="true"]').evaluateAll((elements) => {
    for (const element of elements) element.dataset.unread = "false";
  });

  for (const row of await titleWeights())
    assert.equal(row.weight, "400", `${row.id}: marking read clears bold`);

  for (const [row, title] of [
    [".ct-row", ".ct-row-title"],
    [".ctf-row", ".ctf-title"],
  ]) {
    const styles = await page.locator(`${row}:not([data-active="true"])`).evaluateAll(
      (rows, selector) =>
        rows.map((element) => ({
          state: element.dataset.state,
          color: getComputedStyle(element.querySelector(selector)).color,
          weight: getComputedStyle(element.querySelector(selector)).fontWeight,
        })),
      title,
    );

    const open = styles.find((entry) => entry.state === "idle");
    const done = styles.find((entry) => entry.state === "done");

    assert.ok(open && done, `${row}: includes read Open and Ready to archive chats`);
    assert.equal(
      done.color,
      open.color,
      `${row}: read completed and open titles use the same color`,
    );
    assert.equal(
      done.weight,
      open.weight,
      `${row}: read completed and open titles use the same weight`,
    );

    const foreground = await page.evaluate(() => {
      const probe = document.createElement("span");

      probe.style.color = "var(--foreground)";
      document.body.append(probe);

      const color = getComputedStyle(probe).color;

      probe.remove();

      return color;
    });

    for (const entry of styles)
      if (entry.state !== "run")
        assert.equal(
          entry.color,
          foreground,
          `${row}: a ${entry.state} chat that is not running has a full-contrast title`,
        );
  }

  await page.locator(".ct-row, .ctf-row").evaluateAll((rows) => {
    for (const row of rows) {
      const unread = row.querySelector(".ct-unread-dot") !== null;

      row.dataset.unread = String(unread);
      row.querySelector("a").dataset.unread = String(unread);
    }
  });

  const result = await assertNotificationMarkers(page, page.locator("main"));

  assert.equal(result.length, states.length * 2);

  const jStyles = () =>
    page.locator(".ctf-row").evaluateAll((elements) => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });

      const rgba = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "rgba(0, 0, 0, 0)";
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);

        return [...context.getImageData(0, 0, 1, 1).data];
      };

      const hue = ([red, green, blue]) => {
        const max = Math.max(red, green, blue);
        const min = Math.min(red, green, blue);

        if (max === min) return 0;
        const span = max - min;

        const turn =
          max === red
            ? ((green - blue) / span) % 6
            : max === green
              ? (blue - red) / span + 2
              : (red - green) / span + 4;

        return (turn * 60 + 360) % 360;
      };

      return elements.map((row) => {
        const style = getComputedStyle(row.querySelector(":scope > .ctf-row-surface"));
        const link = row.querySelector(".ctf-row-link");
        const lead = link.querySelector(":scope > :not(.ct-unread-dot)");
        const icon = link.querySelector(".ctf-row-project-icon");
        const mark = link.querySelector(".ctf-row-mark");
        const markStyle = mark === null ? null : getComputedStyle(mark);
        const fill = markStyle === null ? [0, 0, 0, 0] : rgba(markStyle.backgroundColor);
        const ring = markStyle === null ? [0, 0, 0, 0] : rgba(markStyle.borderTopColor);
        const iconBox = icon.getBoundingClientRect();
        const markBox = mark?.getBoundingClientRect() ?? null;

        const buttons = [...row.querySelectorAll("button")].map((button) => {
          const box = button.getBoundingClientRect();

          return {
            name: button.textContent,
            radius: parseFloat(getComputedStyle(button).borderTopLeftRadius),
            height: box.height,
          };
        });

        return {
          id: row.dataset.feedRow,
          state: row.dataset.state,
          active: row.dataset.active === "true",
          unread: row.dataset.unread === "true",
          opacity: style.opacity,
          lineOpacity: getComputedStyle(
            row.querySelector(":scope > .ctf-row-surface > .ctf-row-main"),
          ).opacity,
          background: rgba(style.backgroundColor),
          backgroundImage: style.backgroundImage,
          shadow: style.boxShadow,
          border: ["Top", "Right", "Bottom", "Left"].map((side) =>
            style.getPropertyValue(`border-${side.toLowerCase()}-width`),
          ),
          projectFirst: lead !== null && lead.classList.contains("ctf-row-project"),
          stateDots: link.querySelectorAll(".ct-dot").length,
          iconSize: [iconBox.width, iconBox.height],
          iconMask: getComputedStyle(icon).maskImage,
          linkHeight: link.getBoundingClientRect().height,
          mark:
            markBox === null
              ? null
              : {
                  size: [markBox.width, markBox.height],
                  overhang: [markBox.right - iconBox.right, markBox.bottom - iconBox.bottom],
                  filled: fill[3] > 0,
                  fillHue: hue(fill),
                  ringHue: hue(ring),
                  ringWidth: parseFloat(markStyle.borderTopWidth),
                  spin: mark.querySelector(".ctf-row-mark-spin")
                    ? getComputedStyle(mark.querySelector(".ctf-row-mark-spin")).animationName
                    : null,
                },
          buttons,
        };
      });
    });

  const assertJ = async (hovered) => {
    const styles = await jStyles();

    assert.equal(styles.length, J_STATES.length * 2);

    for (const row of styles) {
      assert.equal(row.opacity, "1", `${row.id}: rows stay opaque, so the running dot stays crisp`);
      assert.equal(row.backgroundImage, "none", `${row.id}: no gradient card fill`);
      assert.deepEqual(row.border, ["0px", "0px", "0px", "0px"], `${row.id}: no card border`);
      assert.ok(row.projectFirst, `${row.id}: the project icon is the leading mark`);
      assert.equal(row.stateDots, 0, `${row.id}: no separate state ring`);
      assert.deepEqual(row.iconSize, [16, 16], `${row.id}: the project icon is 16px`);
      assert.ok(row.linkHeight <= 32, `${row.id}: one line per chat`);

      for (const button of row.buttons)
        assert.ok(
          button.radius < button.height / 2,
          `${row.id}: ${button.name} is a rounded rectangle, not a pill`,
        );

      if (row.mark === null)
        assert.equal(row.iconMask, "none", `${row.id}: an unmarked icon has no cut-out`);
      else {
        const working = row.state === "run";

        assert.deepEqual(
          row.mark.size,
          working ? [9, 9] : [7, 7],
          `${row.id}: the state mark is a ${working ? "9px spinner" : "7px dot"}`,
        );
        assert.deepEqual(
          row.mark.overhang,
          working ? [3.5, 3.5] : [2.5, 2.5],
          `${row.id}: the mark sits on the corner`,
        );
        assert.match(row.iconMask, /radial-gradient/u, `${row.id}: the icon cuts out the mark`);
      }

      assert.equal(row.shadow, "none", `${row.id}: no card border ring`);

      if (row.active) {
        const [red, green, blue, alpha] = row.background;

        assert.ok(
          alpha > 0 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 8,
          `${row.id}: the open chat has the soft neutral accent fill`,
        );
        assert.equal(row.lineOpacity, "1", `${row.id}: the open chat is never dimmed`);
      } else {
        if (row.id !== hovered)
          assert.equal(
            row.background[3],
            0,
            `${row.id}: a resting row that is not open has no fill`,
          );
      }
    }

    const markOf = (state) => styles.find((row) => row.state === state && !row.active).mark;

    assert.ok(markOf("need")?.filled, "Needs you is a filled dot");
    assert.equal(markOf("run")?.filled, false, "Working is not a static dot");
    assert.equal(markOf("run")?.spin, "ct-status-spin", "Working spins");
    assert.ok(
      ["need", "blk"].every((state) => markOf(state)?.spin === null),
      "Only Working spins",
    );
    assert.ok(
      ["wait", "done", "idle"].every((state) => markOf(state) === null),
      "Other states leave the project icon unmarked",
    );
    assert.equal(markOf("blk").filled, false, "Blocked is a hollow ring");
    assert.ok(
      markOf("blk").ringWidth > 0 && markOf("blk").ringWidth <= 1.3,
      "Blocked rings with the shared 1.3px pen",
    );
    assert.ok(
      Math.abs(markOf("blk").ringHue - markOf("need").fillHue) < 4,
      "Blocked rings in the Needs you colour",
    );

    return styles.length;
  };

  const checkedRows = await assertJ(null);

  for (const state of J_STATES) {
    const id = `j-${state}-false`;

    await page.locator(`.ctf-row[data-feed-row="${id}"] .ctf-row-link`).hover();
    await assertJ(id);
  }

  console.log(
    JSON.stringify({
      checkedRows: result.length,
      checkedJRows: checkedRows,
      states,
      jStates: J_STATES,
      activeAndUnselected: true,
      hover: true,
    }),
  );
} finally {
  await browser.close();
}
