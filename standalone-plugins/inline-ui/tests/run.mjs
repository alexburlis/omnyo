import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

const outputIndex = process.argv.indexOf("--output");

const outputArgument = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];

if (!outputArgument || !path.isAbsolute(outputArgument)) {
  throw new Error("Pass --output with an absolute, owned evidence directory.");
}

const output = path.resolve(outputArgument);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const proof = {
  result: "running",
  surface: "headless Chrome; production React components and CSS in a host-DOM fixture",
  startedAt: new Date().toISOString(),
  browser: "",
  checks: [],
  screenshots: [],
  limits: ["Does not prove live Omnyo installation, SDK registration, or directive extraction."],
};

let server;

let browser;

let context;

let page;

let failure;

const pageErrors = [];

async function check(name, run) {
  try {
    const detail = await run();
    const entry = { name, result: "pass" };

    if (detail) entry.detail = detail;
    proof.checks.push(entry);
  } catch (error) {
    proof.checks.push({ name, result: "fail", error: String(error).slice(0, 2400) });
    failure ??= error;
  }
}

async function styles(messageName) {
  return page.getByRole("article", { name: messageName }).evaluate((article) => {
    const paragraph = article.querySelector("p[data-paragraph]");
    const item = article.querySelector("li");
    const cell = article.querySelector("[data-markdown-preview] > table th");

    const read = (element, fields) =>
      Object.fromEntries(fields.map((field) => [field, getComputedStyle(element)[field]]));

    return {
      paragraph: read(paragraph, ["fontSize", "lineHeight", "marginTop", "marginBottom", "color"]),
      list: read(item, ["fontSize", "lineHeight", "marginTop", "marginBottom"]),
      cell: read(cell, ["fontSize", "lineHeight", "paddingTop", "paddingBottom"]),
    };
  });
}

async function noOverflow() {
  const dimensions = await page.evaluate(() => {
    const viewport = window.innerWidth;

    const blocks = [...document.querySelectorAll("[data-native-block], [data-native-case]")].map(
      (element) => {
        const rect = element.getBoundingClientRect();

        return {
          name:
            element.getAttribute("data-native-block") ?? element.getAttribute("data-native-case"),
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      },
    );

    return { viewport, scrollWidth: document.documentElement.scrollWidth, blocks };
  });

  assert.ok(
    dimensions.scrollWidth <= dimensions.viewport + 1,
    `Page overflows: ${JSON.stringify(dimensions)}`,
  );

  for (const block of dimensions.blocks) {
    assert.ok(
      block.left >= -1 && block.right <= dimensions.viewport + 1,
      `${block.name} overflows the viewport`,
    );
  }

  return dimensions;
}

async function statusTableRows(section, rows) {
  const bodyRows = section.locator("tbody tr");
  await expect(bodyRows).toHaveCount(rows.length);

  for (const [index, [label, value]] of rows.entries()) {
    await exactVisibleText(bodyRows.nth(index).getByRole("rowheader"), label);
    await exactVisibleText(bodyRows.nth(index).getByRole("cell"), value);

    const layout = await bodyRows
      .nth(index)
      .locator(".omnyo-inline-status__value")
      .evaluate((element) => {
        const cell = element.closest("td");
        const table = element.closest("table");

        return {
          height: element.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(element).lineHeight),
          cellShare: cell.getBoundingClientRect().width / table.getBoundingClientRect().width,
        };
      });

    if (value.length <= 24) {
      assert.ok(
        layout.height < layout.lineHeight * 1.5,
        `Short status value wraps: ${value} ${JSON.stringify(layout)}`,
      );
    } else {
      assert.ok(
        layout.cellShare >= 0.3,
        `Long status value column collapses: ${value} ${JSON.stringify(layout)}`,
      );
    }
  }

  return bodyRows;
}

async function statusValueColors(section) {
  return section
    .locator(".omnyo-inline-status__value")
    .evaluateAll((values) => values.map((value) => getComputedStyle(value).color));
}

async function fileCardSource(section, expected) {
  if (expected.target) {
    const link = section.getByTestId("omnyo-file-link");
    await expect(link).toHaveText(expected.title);
    await expect(link).toHaveAttribute("data-target", JSON.stringify(expected.target));
    await expect(section.getByTestId("omnyo-markdown")).toHaveCount(0);

    return;
  }

  const markdown = section.getByTestId("omnyo-markdown");
  await expect(markdown).toHaveCount(1);
  assert.equal(
    await markdown.textContent(),
    expected,
    "File card did not pass the exact escaped Markdown link to Omnyo's renderer",
  );
}

async function finiteChart(section) {
  const invalid = await section.locator("svg").evaluateAll((svgs) => {
    const coordinateAttributes = [
      "d",
      "points",
      "x",
      "y",
      "x1",
      "x2",
      "y1",
      "y2",
      "cx",
      "cy",
      "r",
      "width",
      "height",
      "transform",
    ];

    return svgs.flatMap((svg) =>
      [...svg.querySelectorAll("*")].flatMap((element) =>
        coordinateAttributes.flatMap((name) => {
          const value = element.getAttribute(name);

          return value !== null && /NaN|Infinity|undefined/u.test(value)
            ? [{ tag: element.tagName, name, value }]
            : [];
        }),
      ),
    );
  });

  assert.deepEqual(invalid, [], "Chart SVG has nonfinite coordinates");
}

async function keyboardPoints(section, expected) {
  const points = section.locator('[role="img"][tabindex]');
  await expect(points).toHaveCount(expected.length);
  const first = points.first();
  await first.focus();
  await expect(first).toBeFocused();

  for (let index = 0; index < expected.length; index += 1) {
    const point = points.nth(index);

    if (index > 0) await page.keyboard.press("ArrowRight");
    await expect(point).toBeFocused();
    await expect(section.getByRole("tooltip")).toBeVisible();
    await expect(section.getByRole("tooltip")).toContainText(expected[index]);
  }

  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("End");
  await expect(points.last()).toBeFocused();
  await finiteChart(section);
}

async function exactVisibleText(section, text) {
  const element = section.getByText(text, { exact: true }).first();
  await expect(element).toBeVisible();

  const dimensions = await element.evaluate((node) => {
    const style = getComputedStyle(node);

    return {
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      textOverflow: style.textOverflow,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
    };
  });

  assert.notEqual(dimensions.textOverflow, "ellipsis", `Exact text is ellipsized: ${text}`);

  if (dimensions.clientWidth > 0 && ["hidden", "clip"].includes(dimensions.overflowX)) {
    assert.ok(
      dimensions.scrollWidth <= dimensions.clientWidth + 1,
      `Exact text is horizontally clipped: ${text}`,
    );
  }

  if (dimensions.clientHeight > 0 && ["hidden", "clip"].includes(dimensions.overflowY)) {
    assert.ok(
      dimensions.scrollHeight <= dimensions.clientHeight + 1,
      `Exact text is vertically clipped: ${text}`,
    );
  }
}

async function comparisonGeometry(section, values) {
  const geometry = await section.locator(".omnyo-inline-comparison__fill").evaluateAll((fills) =>
    fills.map((fill) => {
      const track = fill.closest(".omnyo-inline-comparison__track");

      if (!track) throw new Error("Rendered comparison fill has no track");
      const barRect = fill.getBoundingClientRect();
      const trackRect = track.getBoundingClientRect();

      return {
        left: barRect.left - trackRect.left,
        right: barRect.right - trackRect.left,
        width: barRect.width,
        height: barRect.height,
        trackWidth: trackRect.width,
      };
    }),
  );

  assert.equal(geometry.length, values.length, "Comparison loses or fabricates a bar");
  const numbers = values.map(Number);
  const maximumMagnitude = Math.max(...numbers.map(Math.abs));
  const largestIndex = numbers.findIndex((value) => Math.abs(value) === maximumMagnitude);
  const largestWidth = geometry[largestIndex].width;
  const origins = geometry.map((bar, index) => (numbers[index] < 0 ? bar.right : bar.left));
  const hasNegative = numbers.some((value) => value < 0);
  const hasPositive = numbers.some((value) => value > 0);

  for (let index = 0; index < geometry.length; index += 1) {
    const bar = geometry[index];
    assert.ok(
      Object.values(bar).every(Number.isFinite),
      "Comparison has nonfinite rendered geometry",
    );
    assert.ok(
      bar.trackWidth > 0 && bar.height > 0,
      "Comparison track or fill has no rendered dimension",
    );
    assert.ok(
      Math.abs(bar.trackWidth - geometry[0].trackWidth) <= 1,
      "Comparison series do not share track widths",
    );
    assert.ok(
      bar.left >= -1 && bar.right <= bar.trackWidth + 1,
      "Comparison fill leaves its numeric track",
    );
    assert.ok(
      Math.abs(origins[index] - origins[0]) <= 1,
      "Comparison bars do not share one zero origin",
    );

    const expectedWidth =
      maximumMagnitude === 0 ? 0 : largestWidth * (Math.abs(numbers[index]) / maximumMagnitude);

    assert.ok(
      Math.abs(bar.width - expectedWidth) <= 1,
      `Comparison uses different numeric scales: ${JSON.stringify({ index, value: values[index], expectedWidth, bar })}`,
    );
  }

  if (maximumMagnitude > 0)
    assert.ok(largestWidth > 1, "Valid nonzero values collapsed to zero-width bars");

  if (hasNegative && hasPositive) {
    assert.ok(
      origins[0] > 1 && origins[0] < geometry[0].trackWidth - 1,
      "Signed comparison zero is not inside the shared track",
    );
  } else if (hasNegative) {
    assert.ok(
      Math.abs(origins[0] - geometry[0].trackWidth) <= 1,
      "Negative comparison bars do not end at the right zero origin",
    );
  } else if (hasPositive) {
    assert.ok(
      Math.abs(origins[0]) <= 1,
      "Positive comparison bars do not start at the left zero origin",
    );
  }

  return geometry;
}

async function comparisonKeyboard(section, expected) {
  const bars = section.locator('[role="img"][tabindex]');
  await expect(bars).toHaveCount(expected.length);
  await expect(bars.first()).toHaveAttribute("tabindex", "0");
  await bars.first().focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(bars.first()).toBeFocused();

  for (let index = 0; index < expected.length; index += 1) {
    if (index > 0) await page.keyboard.press("ArrowRight");
    const bar = bars.nth(index);
    await expect(bar).toBeFocused();

    for (const text of expected[index]) {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      await expect(bar).toHaveAccessibleName(new RegExp(escaped, "u"));
    }
  }

  await page.keyboard.press("Home");
  await expect(bars.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(bars.last()).toBeFocused();

  if (expected.length > 1) {
    await page.keyboard.press("ArrowLeft");
    await expect(bars.nth(expected.length - 2)).toBeFocused();
  }
}

async function comparisonTable(section, categories, values, series) {
  const table = section.getByRole("table");

  if (!(await table.isVisible())) await section.locator("summary").click();
  await expect(table).toBeVisible();
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(categories.length);

  for (let index = 0; index < categories.length; index += 1) {
    const row = rows.nth(index);
    await expect(row.getByRole("rowheader")).toHaveText(categories[index]);
    await expect(row.getByRole("cell")).toHaveText(values[index]);
  }

  for (const name of series)
    await expect(table.getByRole("columnheader", { name: new RegExp(name, "u") })).toBeVisible();

  if (await section.locator("details[open]").count()) await section.locator("summary").click();
}

async function orderedItems(section, labels) {
  const list = section.locator("ol");
  await expect(list).toBeVisible();
  const items = list.locator(":scope > li");
  await expect(items).toHaveCount(labels.length);

  for (let index = 0; index < labels.length; index += 1) {
    await exactVisibleText(items.nth(index), labels[index]);

    const nativeNumber = await items
      .nth(index)
      .evaluate((item) => getComputedStyle(item).listStyleType !== "none");

    if (!nativeNumber)
      await expect(items.nth(index).getByText(String(index + 1), { exact: true })).toBeVisible();
  }

  await expect(section.getByRole("progressbar")).toHaveCount(0);
  assert.doesNotMatch(
    await section.innerText(),
    /\d+(?:\.\d+)?\s*%/u,
    "Steps invent a completion percentage",
  );

  return items;
}

try {
  await mkdir(output, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    server: { host: "127.0.0.1", port: 0, strictPort: true },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(
    Number.isInteger(address?.port) && address.port > 0,
    "Vite did not bind its ephemeral TCP port",
  );
  browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
  proof.browser = browser.version();
  context = await browser.newContext({
    viewport: { width: 900, height: 1000 },
    deviceScaleFactor: 1,
  });
  page = await context.newPage();
  page.on("pageerror", (error) => {
    if (pageErrors.length < 10) pageErrors.push(String(error).slice(0, 1000));
  });
  await page.goto(`http://127.0.0.1:${address.port}/tests/demo.html`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Inline UI preview" })).toBeVisible();

  for (const width of [900, 360]) {
    await page.setViewportSize({ width, height: 1000 });

    for (const theme of ["light", "dark"]) {
      await page.getByLabel("Theme", { exact: true }).selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await check(`mixed content, ${width}px, ${theme}`, async () => {
        const metrics = page.locator('[data-native-block="metrics"]');

        for (const exactText of [
          "Accounts",
          "Weekly visitors",
          "Google clicks",
          "46",
          "339",
          "274",
          "Oct 11",
          "Oct 4–10 · +8%",
          "Oct 2–8 · +24.5%",
        ]) {
          await expect(metrics.getByText(exactText, { exact: true })).toBeVisible();
        }

        await expect(
          page.getByText("Native blocks keep the surrounding prose readable.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.locator('[data-native-block="badge"]').getByText("Example", { exact: true }),
        ).toBeVisible();
        const progress = page.getByRole("progressbar", { name: "Example coverage" });
        await expect(progress).toHaveAttribute("aria-valuenow", "68");
        await expect(progress).toHaveAttribute("aria-valuemax", "100");
        await expect(
          page.getByText("End of the inline UI preview.", { exact: true }),
        ).toBeVisible();
        await expect(page.locator("iframe")).toHaveCount(0);
        await expect(
          page.getByRole("article", { name: "Assistant message" }).locator("pre code"),
        ).toContainText("omnyo inline-ui metrics");

        const comparison = page.locator('[data-native-block="comparison"]');

        for (const text of [
          "Public documentation coverage",
          "Local browser verification",
          "Production installation proof",
          "8.00",
          "4.50",
          "2.25",
          "4.00",
          "1.125",
          "Example A",
          "Example B",
          "items",
          "Invented values; common scale for layout verification",
        ]) {
          await exactVisibleText(comparison, text);
        }

        await expect(comparison.locator(".omnyo-inline-comparison__legend")).toBeVisible();
        assert.doesNotMatch(
          await comparison.innerText(),
          /\bLatest\b/u,
          "Category comparison implies chronological order",
        );
        await expect(comparison.locator('[aria-label*="Latest"]')).toHaveCount(0);

        const comparisonLayout = await comparisonGeometry(comparison, [
          "8.00",
          "4.00",
          "4.50",
          "2.25",
          "2.25",
          "1.125",
        ]);

        const steps = page.locator('[data-native-block="steps"]');

        const stepItems = await orderedItems(steps, [
          "Inspect evidence",
          "Apply scoped repair",
          "Verify the result",
        ]);

        for (const [index, state] of ["Done", "Running", "Pending"].entries()) {
          await expect(
            stepItems.nth(index).getByText(new RegExp(`^${state}$`, "iu")),
          ).toBeVisible();
        }

        await exactVisibleText(steps, "Example only · Oct 11, 2026");
        await exactVisibleText(steps, "Example states for layout verification");

        const status = page.locator('[data-native-block="status"]');

        const statusRows = await statusTableRows(status, [
          ["Example junk item", "Hidden"],
          ["Example useful item", "Kept"],
          ["Example rare affix", "Highlighted"],
        ]);

        await exactVisibleText(statusRows.nth(0), "Common and magic examples");
        await exactVisibleText(status, "Example changes");
        await exactVisibleText(status, "Example rows for layout verification");
        await expect(status.getByRole("columnheader", { name: "Drop" })).toBeVisible();
        await expect(status.getByRole("columnheader", { name: "New behavior" })).toBeVisible();

        const statusColors = await statusValueColors(status);

        assert.equal(
          new Set(statusColors).size,
          3,
          `Status tones are not distinct: ${statusColors}`,
        );

        const file = page.locator('[data-native-block="file"]');
        await fileCardSource(file, {
          title: "Example filter download",
          target: {
            kind: "host",
            hostId: "fixture-machine",
            path: "/fixture/storage/example filter.txt",
          },
        });
        await exactVisibleText(file, "12 rules · Example season");
        await expect(file.locator("svg.omnyo-inline-file__glyph")).toBeVisible();

        for (const nativeBlock of [comparison, steps, status, file]) {
          const colors = await nativeBlock.evaluate((element) => ({
            foreground: getComputedStyle(element.firstElementChild).color,
            background: getComputedStyle(document.body).backgroundColor,
          }));

          assert.notEqual(
            colors.foreground,
            colors.background,
            "New block text disappears into its theme background",
          );
        }

        const themeColors = await page
          .locator('[data-native-block="metrics"]')
          .evaluate((element) => {
            const style = getComputedStyle(element.firstElementChild);

            return {
              foreground: style.color,
              background: getComputedStyle(document.body).backgroundColor,
            };
          });

        assert.notEqual(
          themeColors.foreground,
          themeColors.background,
          "Metric foreground disappears into the theme background",
        );
        await finiteChart(page.locator('[data-native-block="chart"]'));

        return { ...(await noOverflow()), themeColors, comparisonLayout };
      });
    }
  }

  await check("assistant-only Markdown typography", async () => {
    const assistantEnabled = await styles("Assistant message");
    const userEnabled = await styles("User message");
    await page
      .locator("html")
      .evaluate((element) => element.removeAttribute("data-omnyo-inline-ui"));
    const assistantDisabled = await styles("Assistant message");
    const userDisabled = await styles("User message");
    await page
      .locator("html")
      .evaluate((element) => element.setAttribute("data-omnyo-inline-ui", "true"));
    assert.deepEqual(userEnabled, userDisabled, "Assistant typography overrides user Markdown");
    assert.notDeepEqual(
      assistantEnabled.paragraph,
      assistantDisabled.paragraph,
      "Opt-in does not change assistant paragraph typography",
    );

    const lineRatio =
      parseFloat(assistantEnabled.paragraph.lineHeight) /
      parseFloat(assistantEnabled.paragraph.fontSize);

    assert.ok(
      Math.abs(lineRatio - 1.7) < 0.01,
      `Expected assistant line height 1.7, received ${lineRatio}`,
    );

    return { assistantEnabled, assistantDisabled, userEnabled, userDisabled };
  });

  await check("chart is reachable by Tab and exposes exact keyboard tooltips", async () => {
    await page.getByLabel("Theme", { exact: true }).focus();
    await page.keyboard.press("Tab");
    const chart = page.locator('[data-native-block="chart"]');
    await expect(chart.locator('[role="img"][tabindex]').first()).toBeFocused();
    await keyboardPoints(chart, ["274", "281", "288", "303", "310", "326", "339"]);
    const points = chart.locator('[role="img"][tabindex]');
    await page.keyboard.press("Home");
    await points.first().hover();
    await page.keyboard.press("ArrowRight");
    await expect(points.nth(1)).toBeFocused();
    const focusedTooltip = chart.getByRole("tooltip");
    await expect(focusedTooltip).toContainText("Mon");
    await expect(focusedTooltip).toContainText("281 visitors");
    await expect(points.nth(1)).toHaveAttribute(
      "aria-describedby",
      await focusedTooltip.getAttribute("id"),
    );
    await expect(points.first()).not.toHaveAttribute("aria-describedby");
    const summary = chart.getByText("Data · 7 points", { exact: true });
    await summary.click();
    const data = chart.getByRole("table");
    await expect(data).toBeVisible();
    await expect(data.getByText("274", { exact: true })).toBeVisible();
    await expect(data.getByText("339", { exact: true })).toBeVisible();
    await summary.click();
  });

  for (const [fixture, values] of [
    ["flat", ["5", "5", "5"]],
    ["zero", ["0", "0", "0"]],
    ["negative", ["-3", "-1.25", "-4", "0"]],
    ["tiny", ["0.0000001", "0.0000002"]],
  ]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} series preserves exact values and finite geometry`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);
      await expect(section.locator("svg")).toBeVisible();
      await keyboardPoints(section, values);
      await noOverflow();
    });
  }

  await page.getByLabel("Fixture case", { exact: true }).selectOption("comparison-single");
  await check(
    "category comparison preserves source order, exact decimals, default series and keyboard/table access",
    async () => {
      const section = page.locator('[data-native-case="comparison-single"]');
      const categories = ["Third category", "First category", "Second category"];
      const values = ["8.00", "4.00", "2.00"];
      const rows = section.locator(".omnyo-inline-comparison__row");
      await expect(rows).toHaveCount(categories.length);

      for (let index = 0; index < categories.length; index += 1) {
        await exactVisibleText(rows.nth(index), categories[index]);
        await exactVisibleText(rows.nth(index), values[index]);
      }

      await comparisonKeyboard(
        section,
        categories.map((category, index) => [category, "Values", values[index], "points"]),
      );
      await comparisonTable(
        section,
        categories,
        values.map((value) => [value]),
        ["Values"],
      );
      await expect(section.locator(".omnyo-inline-comparison__legend")).toHaveCount(0);

      return comparisonGeometry(section, values);
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("comparison-paired");
  await check(
    "paired category comparison uses one scale with explicit series and accessible exact data",
    async () => {
      const section = page.locator('[data-native-case="comparison-paired"]');

      const categories = [
        "Public documentation coverage",
        "Local browser verification",
        "Production installation proof",
      ];

      const values = [
        ["8.00", "4.00"],
        ["4.50", "2.25"],
        ["2.25", "1.125"],
      ];

      const expected = categories.flatMap((category, index) =>
        values[index].map((value, seriesIndex) => [
          category,
          seriesIndex === 0 ? "Example A" : "Example B",
          value,
          "items",
        ]),
      );

      await comparisonKeyboard(section, expected);
      await comparisonTable(section, categories, values, ["Example A", "Example B"]);

      return comparisonGeometry(section, values.flat());
    },
  );

  for (const [fixture, values] of [
    ["comparison-zero", ["0", "0.00", "0"]],
    ["comparison-negative", ["-6.00", "-3.00", "0"]],
    ["comparison-mixed", ["-3.00", "6.00", "0", "-1.50", "6.00", "3.00"]],
    ["comparison-tiny", ["5e-324", "1e-323"]],
  ]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} has honest shared zero-origin geometry and exact values`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);

      for (const value of values) await exactVisibleText(section, value);
      await noOverflow();

      return comparisonGeometry(section, values);
    });
  }

  for (const [fixture, labels, value] of [
    ["comparison-one", ["Only category"], "1.2500"],
    [
      "comparison-twelve",
      Array.from({ length: 12 }, (_, index) => `Full category name ${index + 1}`),
    ],
    ["steps-one", ["Only action"]],
    ["steps-twelve", Array.from({ length: 12 }, (_, index) => `Full step label ${index + 1}`)],
  ]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} accepts the public list-size bound`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);

      for (const label of labels) await exactVisibleText(section, label);

      if (fixture.startsWith("steps-")) await orderedItems(section, labels);
      else await expect(section.locator('[role="img"][tabindex]')).toHaveCount(labels.length);

      if (value) await exactVisibleText(section, value);
      await noOverflow();
    });
  }

  await page.getByLabel("Fixture case", { exact: true }).selectOption("steps-neutral");
  await check(
    "neutral ordered steps preserve order and imply no completion or status",
    async () => {
      const section = page.locator('[data-native-case="steps-neutral"]');
      await orderedItems(section, ["Third action", "First action", "Second action"]);
      assert.doesNotMatch(
        await section.innerText(),
        /\b(?:pending|queued|running|done|waiting|blocked|failed|unknown)\b/iu,
        "Omitted states invent status",
      );
      await noOverflow();
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("steps-all-states");
  await check(
    "all eight ordered-step states are visible and queued remains distinct from done",
    async () => {
      const section = page.locator('[data-native-case="steps-all-states"]');

      const states = [
        "Pending",
        "Queued",
        "Running",
        "Done",
        "Waiting",
        "Blocked",
        "Failed",
        "Unknown",
      ];

      const items = await orderedItems(
        section,
        states.map((state) => `${state} example`),
      );

      for (let index = 0; index < states.length; index += 1) {
        await expect(
          items.nth(index).getByText(new RegExp(`^${states[index]}$`, "iu")),
        ).toBeVisible();
      }

      await expect(items.nth(1).getByText(/^done$/iu)).toHaveCount(0);
      await noOverflow();
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("steps-detail");
  await check(
    "ordered-step details, blank slots, as-of and literal references retain their item ownership",
    async () => {
      const section = page.locator('[data-native-case="steps-detail"]');

      const items = await orderedItems(section, [
        "Inspect evidence",
        "Apply scoped repair",
        "Verify the result",
      ]);

      await exactVisibleText(items.nth(0), "Read the selected inputs");
      await exactVisibleText(items.nth(2), "Record browser proof");
      await expect(items.nth(1)).not.toContainText("Read the selected inputs");
      await expect(items.nth(1)).not.toContainText("Record browser proof");

      for (const [index, reference] of [
        "@thread:thr_example#msg=42",
        "_literal_ `reference`",
        "Fixture proof",
      ].entries()) {
        await exactVisibleText(items.nth(index), reference);
      }

      await exactVisibleText(section, "Example only · Oct 11, 2026");
      await exactVisibleText(section, "Example states for layout verification");
      await expect(section.getByRole("link")).toHaveCount(0);
      await expect(section.locator("img, iframe, script")).toHaveCount(0);
      await noOverflow();
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-ready");
  await check(
    "a content-identified plan exposes a model selector beside Execute and forwards one selected request",
    async () => {
      const section = page.locator('[data-native-case="file-plan-ready"]');
      await expect(section.getByRole("button", { name: "Execute", exact: true })).toBeVisible();
      await expect(
        section.getByRole("button", { name: "Execution model", exact: true }),
      ).toHaveText("current-model · ultra");
      await section.getByRole("button", { name: "Execution model", exact: true }).click();
      await expect(
        section.getByRole("button", { name: "Execution model", exact: true }),
      ).toHaveText("other-model · high");
      await section.getByRole("button", { name: "Execute", exact: true }).dblclick();
      await expect(section.getByRole("button", { name: "Open run", exact: true })).toBeVisible();

      const result = await page.evaluate(() => ({
        calls: globalThis.inlineUiPlanCalls,
        navigations: globalThis.inlineUiPlanNavigation,
      }));

      assert.equal(result.calls.length, 1);
      assert.deepEqual(result.calls[0].selection, {
        providerId: "other-provider",
        model: "other-model",
        reasoningLevel: "high",
        serviceTier: "default",
      });
      assert.equal(result.calls[0].environmentId, "fixture-environment");
      assert.equal(result.calls[0].sha256, "b".repeat(64));
      assert.ok(result.navigations.includes("fixture-execution"));
      await noOverflow();
    },
  );

  await page.setViewportSize({ width: 900, height: 1000 });
  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-complete");
  await check(
    "a completed plan preserves its file and shows status without execution controls",
    async () => {
      const section = page.locator('[data-native-case="file-plan-complete"]');
      await expect(section.getByRole("status")).toHaveText("Completed");
      await expect(section.getByRole("button", { name: "Execute", exact: true })).toHaveCount(0);
      await expect(
        section.getByRole("button", { name: "Execution model", exact: true }),
      ).toHaveCount(0);
      await fileCardSource(section, {
        title: "Completed comparison plan",
        target: { kind: "host", hostId: "fixture-machine", path: "/fixture/plan-complete.md" },
      });
      await exactVisibleText(section, "Measured results retained");
      await noOverflow();
      await section.screenshot({ path: path.join(output, "plan-card-completed.png") });
      proof.screenshots.push("plan-card-completed.png");
      await page.setViewportSize({ width: 360, height: 1000 });
      await noOverflow();
      await section.screenshot({ path: path.join(output, "plan-card-completed-phone.png") });
      proof.screenshots.push("plan-card-completed-phone.png");
      await page.setViewportSize({ width: 900, height: 1000 });
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-complete-open");
  await check(
    "a completed plan can open its existing run without offering another execution",
    async () => {
      const section = page.locator('[data-native-case="file-plan-complete-open"]');
      await expect(section.getByRole("status")).toHaveText("Completed");
      await expect(
        section.getByRole("button", { name: "Execution model", exact: true }),
      ).toHaveCount(0);
      await expect(section.getByRole("button", { name: "Execute", exact: true })).toHaveCount(0);

      const before = await page.evaluate(() => ({
        calls: globalThis.inlineUiPlanCalls.length,
        navigations: globalThis.inlineUiPlanNavigation.length,
      }));

      await section.getByRole("button", { name: "Open run", exact: true }).click();

      const after = await page.evaluate(() => ({
        calls: globalThis.inlineUiPlanCalls.length,
        navigations: globalThis.inlineUiPlanNavigation.length,
      }));

      assert.equal(after.calls, before.calls);
      assert.equal(after.navigations, before.navigations + 1);
      await section.screenshot({ path: path.join(output, "plan-card-completed-open.png") });
      proof.screenshots.push("plan-card-completed-open.png");
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-complete-pending");
  await check(
    "a completed plan still reconciles an uncertain existing start without executing",
    async () => {
      const section = page.locator('[data-native-case="file-plan-complete-pending"]');
      await expect(section.getByText("Blocked", { exact: true })).toBeVisible();
      await expect(
        section.getByRole("button", { name: "Execution model", exact: true }),
      ).toHaveCount(0);
      await expect(section.getByRole("button", { name: "Execute", exact: true })).toHaveCount(0);
      const before = await page.evaluate(() => globalThis.inlineUiPlanCalls.length);
      await section.getByRole("button", { name: "Check run", exact: true }).click();
      await expect(section.getByRole("button", { name: "Check run", exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => globalThis.inlineUiPlanCalls.length), before);
      await section.screenshot({ path: path.join(output, "plan-card-completed-pending.png") });
      proof.screenshots.push("plan-card-completed-pending.png");
    },
  );

  for (const [fixture, label, hasOwner] of [
    ["file-plan-owned", "Running", true],
    ["file-plan-executing", "In progress", false],
    ["file-plan-blocked", "Blocked", false],
    ["file-plan-no-work", "No remaining steps", false],
  ]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${label} plan never advertises a model or a new Execute action`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);
      await expect(section.getByRole("status")).toHaveText(label);
      await expect(section.getByRole("button", { name: "Execute", exact: true })).toHaveCount(0);
      await expect(
        section.getByRole("button", { name: "Execution model", exact: true }),
      ).toHaveCount(0);
      await expect(section.getByTestId("omnyo-file-link")).toBeVisible();

      if (hasOwner) {
        const calls = await page.evaluate(() => globalThis.inlineUiPlanCalls.length);
        await section.getByRole("button", { name: "Open run", exact: true }).click();
        assert.equal(await page.evaluate(() => globalThis.inlineUiPlanCalls.length), calls);
      }

      await section.screenshot({ path: path.join(output, `${fixture}.png`) });
      proof.screenshots.push(`${fixture}.png`);
    });
  }

  await page.setViewportSize({ width: 360, height: 1000 });
  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-missing-default");
  await check("an unavailable saved default can be replaced using the card selector", async () => {
    const section = page.locator('[data-native-case="file-plan-missing-default"]');
    await expect(section.getByRole("button", { name: "Execute", exact: true })).toBeDisabled();
    await expect(section.getByRole("status")).toContainText("saved default model is unavailable");
    await section.getByRole("button", { name: "Execution model", exact: true }).click();
    await expect(section.getByRole("button", { name: "Execute", exact: true })).toBeEnabled();
    await expect(section.getByRole("status")).toHaveCount(0);
  });

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-changed");
  await check("changed plan failures keep the file link and require a refresh", async () => {
    const section = page.locator('[data-native-case="file-plan-changed"]');
    await section.getByRole("button", { name: "Execute", exact: true }).click();
    await expect(section.getByRole("status")).toContainText("The plan changed");
    await expect(section.getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
    await expect(section.locator('[data-testid="omnyo-file-link"]')).toBeVisible();
    await expect(section.getByRole("button", { name: "Execute", exact: true })).toHaveCount(0);
  });

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-pending");
  await check(
    "an uncertain start checks the existing run instead of sending Execute again",
    async () => {
      const section = page.locator('[data-native-case="file-plan-pending"]');
      await section.getByRole("button", { name: "Execute", exact: true }).click();
      await expect(section.getByRole("button", { name: "Check run", exact: true })).toBeVisible();
      const before = await page.evaluate(() => globalThis.inlineUiPlanCalls.length);
      await section.getByRole("button", { name: "Check run", exact: true }).click();
      await expect(section.getByRole("button", { name: "Open run", exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => globalThis.inlineUiPlanCalls.length), before);
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-unavailable");
  await check(
    "unavailable Pursue leaves the original file link usable with a visible diagnostic",
    async () => {
      const section = page.locator('[data-native-case="file-plan-unavailable"]');
      await expect(section.getByRole("status")).toContainText("Pursue is unavailable");
      await expect(section.locator('[data-testid="omnyo-file-link"]')).toBeVisible();
      await expect(section.getByRole("button", { name: "Execute", exact: true })).toHaveCount(0);
    },
  );

  for (const [fixture, title, checked] of [
    ["file-absent", "Motion spec", "/fixture/absent/DESIGN.md"],
    ["file-absent-relative", "Relative notes", "/fixture/workspace/absent/notes.txt"],
  ]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} shows File not found instead of a link or plan error`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);
      await expect(section.getByRole("status")).toHaveText(`File not found: ${checked}`);
      await expect(section.locator(".omnyo-inline-file__link")).toHaveText(title);
      await expect(section.getByTestId("omnyo-file-link")).toHaveCount(0);
      await expect(section).not.toContainText("Plan actions unavailable");
      await expect(section.getByRole("button")).toHaveCount(0);

      const evidence = await page.evaluate(() => ({
        previews: [...globalThis.inlineUiMissingFilePreviews],
        checks: [...globalThis.inlineUiFileChecks],
      }));

      assert.deepEqual(evidence.previews, []);
      assert.ok(
        evidence.checks.some(
          (entry) => entry.hostId === "fixture-machine" && entry.paths.includes(checked),
        ),
        "The card did not check the resolved path on the message's machine",
      );
      await noOverflow();

      if (fixture === "file-absent") {
        await section.screenshot({ path: path.join(output, "file-absent.png") });
        proof.screenshots.push("file-absent.png");
      }
    });
  }

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-removed");
  await check("a plan removed after rendering turns into File not found on refocus", async () => {
    const section = page.locator('[data-native-case="file-plan-removed"]');
    await expect(section.getByRole("button", { name: "Execute", exact: true })).toBeVisible();
    await page.evaluate(() => {
      globalThis.inlineUiRemoveFile("/fixture/plan-removed.md");
      window.dispatchEvent(new Event("focus"));
    });
    await expect(section.getByRole("status")).toHaveText(
      "File not found: /fixture/plan-removed.md",
    );
    await expect(section).not.toContainText("Plan actions unavailable");
    await expect(section.getByTestId("omnyo-file-link")).toHaveCount(0);
    await expect(section.getByRole("button")).toHaveCount(0);
    await section.screenshot({ path: path.join(output, "file-not-found.png") });
    proof.screenshots.push("file-not-found.png");
  });

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-focus");
  await check("a click that refocuses the window starts the plan on the first try", async () => {
    const section = page.locator('[data-native-case="file-plan-focus"]');
    const execute = section.getByRole("button", { name: "Execute", exact: true });
    await expect(execute).toBeVisible();
    const box = await execute.boundingBox();
    assert.ok(box);
    const before = await page.evaluate(() => globalThis.inlineUiPlanCalls.length);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect
      .poll(() => page.evaluate(() => globalThis.inlineUiPlanCalls.length), { timeout: 2000 })
      .toBe(before + 1);
  });

  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-shared");
  await check(
    "cards for one plan share a preview, keep their controls during live refreshes and ignore unrelated runs",
    async () => {
      const section = page.locator('[data-native-case="file-plan-shared"]');
      const openRun = section.getByRole("button", { name: "Open run", exact: true });

      const calls = () =>
        page.evaluate(
          () =>
            globalThis.inlineUiPreviewCalls.filter((href) => href.includes("plan-owned-shared"))
              .length,
        );

      await expect(openRun).toHaveCount(2);
      assert.equal(await calls(), 1);
      await page.evaluate(() => {
        for (const threadId of ["fixture-execution", "fixture-execution"])
          globalThis.inlineUiEmitRealtime("plan-run-changed", {
            threadId,
            parentThreadId: "fixture-thread",
          });
      });
      await expect.poll(calls).toBe(2);
      await expect(openRun).toHaveCount(2);
      await page.waitForTimeout(700);
      assert.equal(await calls(), 2);
      await expect(openRun).toHaveCount(2);
      await page.evaluate(() =>
        globalThis.inlineUiEmitRealtime("plan-run-changed", {
          threadId: "unrelated-run",
          parentThreadId: "unrelated-chat",
        }),
      );
      await page.waitForTimeout(400);
      assert.equal(await calls(), 2);
    },
  );

  await page.setViewportSize({ width: 360, height: 900 });
  await page.getByLabel("Fixture case", { exact: true }).selectOption("file-plan-ready");
  await check("plan execution controls wrap without horizontal overflow on a phone", async () => {
    const section = page.locator('[data-native-case="file-plan-ready"]');
    await expect(section.getByRole("button", { name: "Open run", exact: true })).toBeVisible();
    await noOverflow();
    await section.screenshot({ path: path.join(output, "plan-card-phone.png") });
    proof.screenshots.push("plan-card-phone.png");
  });
  await page.setViewportSize({ width: 900, height: 1000 });
  await page
    .locator('[data-native-case="file-plan-ready"]')
    .screenshot({ path: path.join(output, "plan-card-desktop.png") });
  proof.screenshots.push("plan-card-desktop.png");

  await page.getByLabel("Fixture case", { exact: true }).selectOption("status-tones");
  await check("status table shows all six tones with distinct colors by meaning", async () => {
    const section = page.locator('[data-native-case="status-tones"]');

    await statusTableRows(section, [
      ["Neutral row", "Visible"],
      ["Positive row", "Passed"],
      ["Warning row", "Needs approval"],
      ["Negative row", "Failed"],
      ["Info row", "Changed"],
      ["Muted row", "Skipped"],
    ]);

    const colors = await statusValueColors(section);

    assert.equal(new Set(colors).size, 6, `Status tones are not distinct: ${colors}`);
    await expect(section.locator("thead")).toHaveCount(0);
    await expect(section.locator("figcaption")).toHaveCount(0);
    await noOverflow();

    return { colors };
  });

  await page.getByLabel("Fixture case", { exact: true }).selectOption("status-agent-success");
  await check("the documented success alias renders the agent's table as positive", async () => {
    const section = page.locator('[data-native-case="status-agent-success"]');

    await statusTableRows(section, [
      ["Canvas features (sections, views, canvas chats, sidebar row)", "Done and live"],
      ["iPhone-size layout in iOS Simulator Safari", "Passed"],
      ["Smoothness at 60 fps", "Not measured"],
    ]);
    assert.deepEqual(
      await section
        .locator("td[data-tone]")
        .evaluateAll((cells) => cells.map((cell) => cell.dataset.tone)),
      ["positive", "positive", "warning"],
    );
    await expect(section.locator(".omnyo-inline-fallback, [role=note]")).toHaveCount(0);
  });

  await page.getByLabel("Fixture case", { exact: true }).selectOption("callout-agent-body");
  await check("a callout without text renders its title", async () => {
    const section = page.locator('[data-native-case="callout-agent-body"]');

    await expect(section.locator("aside strong")).toHaveText("Your 30-second check", {
      timeout: 1000,
    });
    await expect(section.locator("[role=note], .omnyo-inline-fallback")).toHaveCount(0);
  });

  for (const [fixture, tone] of [
    ["callout-info", "info"],
    ["callout-negative", "negative"],
    ["badge-success", "positive"],
  ]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} renders with the shared ${tone} tone`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);
      const block = section.locator(".omnyo-inline-callout, .omnyo-inline-badge");

      await expect(block).toHaveAttribute("data-tone", tone, { timeout: 1000 });
      await expect(section.locator(".omnyo-inline-fallback, [role=note]")).toHaveCount(0);

      return { color: await block.evaluate((element) => getComputedStyle(element).color) };
    });
  }

  await check("callout tones keep distinct accent colors", async () => {
    const accents = [];

    for (const fixture of ["callout-info", "callout-negative"]) {
      await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
      accents.push(
        await page
          .locator(`[data-native-case="${fixture}"] .omnyo-inline-callout__glyph`)
          .evaluate((element) => getComputedStyle(element).color),
      );
    }

    assert.notEqual(accents[0], accents[1], `Callout accents match: ${accents}`);

    return { accents };
  });

  for (const [fixture, rows] of [
    ["status-plain", [["Only row", "Plain value"]]],
    [
      "status-long",
      [
        ["Short row", "Needs approval"],
        [
          "Long row",
          "The command completed, and this explanation preserves the observed behavior and its verification limits. "
            .repeat(4)
            .trim(),
        ],
      ],
    ],
    [
      "status-twenty",
      Array.from({ length: 20 }, (_, index) => [
        `Full row label ${index + 1}`,
        `Value ${index + 1}`,
      ]),
    ],
  ]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} accepts the public row bound with default neutral tone`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);
      await statusTableRows(section, rows);
      await expect(section.locator('td[data-tone="neutral"]')).toHaveCount(rows.length);
      await noOverflow();
    });
  }

  for (const [fixture, expected] of [
    [
      "file-escaped",
      {
        title: "Report [draft] *v2*_final (1)",
        target: {
          kind: "host",
          hostId: "fixture-machine",
          path: "/fixture/storage/report (1) [draft].md",
        },
      },
    ],
    ["file-url", "[Example pricing page](<https://example.com/pricing?a=1&b=2>)"],
    [
      "file-path",
      {
        title: "COMMANDER-TEST-GUIDE.md",
        target: {
          kind: "host",
          hostId: "fixture-machine",
          path: "/fixture/storage/COMMANDER-TEST-GUIDE.md",
        },
      },
    ],
    [
      "file-relative",
      {
        title: "Example plan",
        target: {
          kind: "workspace",
          environmentId: "fixture-environment",
          path: "docs/plans/example.md",
        },
      },
    ],
    [
      "file-windows",
      {
        title: "Example log",
        target: {
          kind: "host",
          hostId: "fixture-machine",
          path: String.raw`C:\fixture\example.log`,
        },
      },
    ],
  ]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} uses the correct host link contract`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);
      await fileCardSource(section, expected);
      await expect(section.locator("svg.omnyo-inline-file__glyph")).toHaveCount(1);
      await expect(section.locator(".omnyo-inline-fallback")).toHaveCount(0);
      await noOverflow();
    });
  }

  await page
    .getByLabel("Fixture case", { exact: true })
    .selectOption("status-opportunity-mismatch");
  await check("mismatched opportunity rows read as plain text without an error", async () => {
    const section = page.locator('[data-native-case="status-opportunity-mismatch"]');

    const fallback = section.locator(".omnyo-inline-fallback");
    await expect(fallback).toBeVisible();
    await expect(fallback.locator("li")).toHaveText([
      "Cache npm downloads for clean consumer installs — Best first candidate",
      "Concrete gap; current cache covers pnpm only — Second priority",
      "Profile slow release checks and setup",
      "Find avoidable work in the roughly 10-minute sweep",
    ]);
    await expect(section.locator("table, [role=note]")).toHaveCount(0);
    await noOverflow();
    await section.screenshot({ path: path.join(output, "opportunity-mismatch.png") });
    proof.screenshots.push("opportunity-mismatch.png");
  });

  await page.getByLabel("Fixture case", { exact: true }).selectOption("status-opportunities");
  await check(
    "opportunities render as two rows with explanations under their own labels",
    async () => {
      const section = page.locator('[data-native-case="status-opportunities"]');

      const rows = await statusTableRows(section, [
        ["Cache npm downloads for clean consumer installs", "Best first candidate"],
        ["Profile slow release checks and setup", "Second priority"],
      ]);

      await expect(section.getByRole("columnheader")).toHaveText(["Opportunity", "Value"]);
      await expect(rows.nth(0).locator(".omnyo-inline-status__detail")).toHaveText(
        "Concrete gap; current cache covers pnpm only",
      );
      await expect(rows.nth(1).locator(".omnyo-inline-status__detail")).toHaveText(
        "Find avoidable work in the roughly 10-minute sweep",
      );
      await expect(section.locator('td[data-tone="info"]')).toHaveCount(2);
      await expect(section.locator(".omnyo-inline-fallback, [role=note]")).toHaveCount(0);
      await noOverflow();
      await section.screenshot({ path: path.join(output, "opportunities.png") });
      proof.screenshots.push("opportunities.png");
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("status-detail-column");
  await check("a third column header shows each row's detail in its own column", async () => {
    const section = page.locator('[data-native-case="status-detail-column"]');

    await expect(section.getByRole("columnheader")).toHaveText(["Part", "Physical?", "Detail"]);
    const rows = section.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).getByRole("rowheader")).toHaveText("Bending at the glass surfaces");
    await expect(rows.nth(0).getByRole("cell")).toHaveText([
      "Yes",
      "Snell's law at the curved top, through the slab, at the flat underside and across an air gap",
    ]);
    await expect(rows.nth(1).getByRole("cell")).toHaveText([
      "No",
      "You look straight down from infinitely far away",
    ]);
    await expect(rows.nth(2).getByRole("cell")).toHaveText(["Deliberately not", ""]);
    await expect(section.locator(".omnyo-inline-status__detail")).toHaveCount(0);
    await expect(section.locator('td[data-tone="positive"]')).toHaveCount(1);
    await expect(section.locator(".omnyo-inline-fallback, [role=note]")).toHaveCount(0);
    await noOverflow();
    await section.screenshot({ path: path.join(output, "detail-column.png") });
    proof.screenshots.push("detail-column.png");
  });

  await page.getByLabel("Fixture case", { exact: true }).selectOption("status-row-order");
  await check(
    "labels written row by row render as the rows their repeated values prove",
    async () => {
      const section = page.locator('[data-native-case="status-row-order"]');

      await expect(section.getByRole("columnheader")).toHaveText(["Check", "Result", "Detail"]);
      const rows = section.locator("tbody tr");
      await expect(rows).toHaveCount(3);

      for (const [index, [label, value, detail]] of [
        ["Core main", "Contains the fix", "Commit on origin/main"],
        ["Plugins main", "Contains the fix", "Pinned for new installs"],
        ["Release lane", "Empty", "Nothing queued"],
      ].entries()) {
        await expect(rows.nth(index).getByRole("rowheader")).toHaveText(label);
        await expect(rows.nth(index).getByRole("cell")).toHaveText([value, detail]);
      }

      await expect(section.locator('td[data-tone="positive"]')).toHaveCount(2);
      await expect(section.locator('td[data-tone="muted"]')).toHaveCount(1);
      await expect(section.locator(".omnyo-inline-fallback, [role=note]")).toHaveCount(0);
      await noOverflow();
      await section.screenshot({ path: path.join(output, "row-order.png") });
      proof.screenshots.push("row-order.png");
    },
  );

  await page.getByLabel("Fixture case", { exact: true }).selectOption("steps-detail-long");
  await check("a paragraph-length step detail renders in full under its own step", async () => {
    const section = page.locator('[data-native-case="steps-detail-long"]');
    const items = await orderedItems(section, ["Measure the release", "Publish it"]);

    const detail = "Run the checks once on the exact candidate and keep the receipt beside it. "
      .repeat(5)
      .trim();

    await exactVisibleText(items.nth(0), detail);
    await expect(items.nth(1)).not.toContainText("Run the checks");
    await expect(section.locator(".omnyo-inline-fallback, [role=note]")).toHaveCount(0);
    await noOverflow();
  });

  const invalidFixtures = [
    "status-missing",
    "status-mismatch",
    "status-empty-value",
    "status-bad-tone",
    "status-tone-mismatch",
    "status-columns",
    "status-detail-mismatch",
    "status-unknown",
    "status-oversize",
    "status-markup",
    "status-control",
    "file-missing-href",
    "file-path-conflict",
    "file-missing-title",
    "file-javascript",
    "file-data",
    "file-angle-href",
    "file-angle-title",
    "file-bad-kind",
    "file-unknown",
    "file-control",
    "malformed",
    "chart-label-mismatch",
    "chart-overflow",
    "chart-underflow",
    "chart-oversize",
    "chart-markup",
    "metric-mismatch",
    "metric-oversize",
    "progress-max",
    "progress-number",
    "progress-unknown",
    "badge-tone",
    "comparison-missing",
    "comparison-empty-label",
    "comparison-mismatch",
    "comparison-malformed",
    "comparison-overflow",
    "comparison-underflow",
    "comparison-unknown",
    "comparison-oversize",
    "comparison-text-oversize",
    "comparison-markup",
    "comparison-control",
    "comparison-pair-mismatch",
    "comparison-pair-unnamed",
    "comparison-pair-second-unnamed",
    "comparison-pair-duplicate",
    "comparison-pair-orphan",
    "steps-missing",
    "steps-empty-label",
    "steps-state-mismatch",
    "steps-bad-state",
    "steps-detail-mismatch",
    "steps-detail-oversize",
    "steps-ref-mismatch",
    "steps-unknown",
    "steps-oversize",
    "steps-text-oversize",
    "steps-markup",
    "steps-control",
  ];

  for (const fixture of invalidFixtures) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} renders readable content without an error`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);

      await expect(section.locator("[role=note]")).toHaveCount(0);
      await expect(section).not.toContainText("Couldn’t show");
      const source = (await section.textContent()) ?? "";

      assert.ok(source.trim().length > 0, "The block rendered nothing");
      await expect(section.locator("iframe, img, script")).toHaveCount(0);
      assert.equal(
        await page.evaluate(() => window.inlineUiPayloadExecuted === true),
        false,
        "Attribute markup executed",
      );

      if (fixture === "chart-markup") {
        assert.ok(
          source.includes("window.inlineUiPayloadExecuted=true"),
          "Markup source was not preserved as text",
        );
      }

      if (fixture === "chart-oversize")
        assert.ok(source.includes(",80"), "Oversized source was silently truncated");
      await noOverflow();

      return { sourceLength: source.length };
    });
  }

  for (const fixture of ["status-email", "steps-email", "comparison-email"]) {
    await page.getByLabel("Fixture case", { exact: true }).selectOption(fixture);
    await check(`${fixture} renders a bracketed address as text`, async () => {
      const section = page.locator(`[data-native-case="${fixture}"]`);
      await expect(section).toContainText("Acme Operations <hello@example.com>");
      await expect(section.locator(".omnyo-inline-fallback")).toHaveCount(0);
    });
  }

  await page.getByLabel("Fixture case", { exact: true }).selectOption("callout-markup");
  await check("callout text markup remains inert literal content", async () => {
    const section = page.locator('[data-native-case="callout-markup"]');
    await expect(section.locator("aside p")).toHaveText(
      '<img src=x onerror="window.inlineUiPayloadExecuted=true">',
    );
    await expect(section.locator("img, iframe, .omnyo-inline-fallback")).toHaveCount(0);
    assert.equal(
      await page.evaluate(() => window.inlineUiPayloadExecuted === true),
      false,
      "Callout text markup executed",
    );
  });

  await check("no uncaught browser errors", () => assert.deepEqual(pageErrors, []));
  await page.getByLabel("Fixture case", { exact: true }).selectOption("mixed");

  for (const [theme, width] of [
    ["light", 900],
    ["dark", 360],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByLabel("Theme", { exact: true }).selectOption(theme);
    await page.getByRole("heading", { name: "Inline UI preview" }).click();
    await page.screenshot({
      path: path.join(output, `${theme}.png`),
      fullPage: true,
      animations: "disabled",
    });
    proof.screenshots.push(`${theme}.png`);
  }

  proof.result = failure ? "fail" : "pass";
} catch (error) {
  failure = error;
  proof.result = "fail";
  proof.error = String(error).slice(0, 4000);
} finally {
  const cleanup = [];

  for (const [name, close] of [
    ["page", () => page?.close()],
    ["context", () => context?.close()],
    ["Chrome and its temporary profile", () => browser?.close()],
    ["ephemeral Vite listener", () => server?.close()],
  ]) {
    try {
      await close();
      cleanup.push({ resource: name, result: "closed" });
    } catch (error) {
      cleanup.push({ resource: name, result: "close failed", error: String(error).slice(0, 1000) });
      failure ??= error;
      proof.result = "fail";
    }
  }

  proof.cleanup = cleanup;
  proof.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
}

if (failure) {
  console.error(
    `E2E failed; proof: ${path.join(output, "proof.json")}\n${String(failure).slice(0, 2400)}`,
  );
  process.exitCode = 1;
} else {
  console.log(`PASS: ${proof.checks.length} browser checks; ${path.join(output, "proof.json")}`);
}
