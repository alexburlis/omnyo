import assert from "node:assert/strict";

export async function measureRailReadings(page) {
  return page.getByTestId("app-nav-rail").evaluate((rail) => {
    const bounds = (element) => {
      const rect = element.getBoundingClientRect();

      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        right: rect.right,
      };
    };

    const resources = rail.querySelector('section[aria-label="Resources"]');
    const usage = rail.querySelector('section[aria-label="Account usage"]');
    const footer = resources?.parentElement ?? usage?.parentElement;
    const sidebar = rail.closest('[data-sidebar="sidebar"]');
    const text = [];

    if (resources) {
      const walker = document.createTreeWalker(resources, NodeFilter.SHOW_TEXT);

      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;

        if (!node.textContent?.trim() || parent.closest("select")) continue;

        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();

        text.push({
          text: node.textContent.trim(),
          fontSize: Number.parseFloat(getComputedStyle(parent).fontSize),
          lines: new Set([...range.getClientRects()].map((line) => line.top))
            .size,
          clamp:
            Number.parseInt(getComputedStyle(parent).webkitLineClamp, 10) || 1,
          x: rect.x,
          right: rect.right,
        });
      }
    }

    return {
      rail: bounds(rail),
      usage: usage ? bounds(usage) : null,
      gauges: [...(usage?.querySelectorAll('[role="img"]') ?? [])].map(
        (gauge) => {
          const value = gauge.querySelector(":scope > span");
          const range = document.createRange();
          range.selectNodeContents(value);

          return {
            label: gauge.getAttribute("aria-label"),
            gauge: bounds(gauge),
            row: [...gauge.parentElement.children].indexOf(gauge) >> 1,
            group: [
              ...(usage?.querySelectorAll('[role="img"]') ?? []),
            ].findIndex((first) => first.parentElement === gauge.parentElement),
            value: bounds(range),
            fontSize: Number.parseFloat(getComputedStyle(value).fontSize),
          };
        },
      ),
      resources: resources ? bounds(resources) : null,
      hasLiveResources: Boolean(resources?.querySelector('[role="meter"]')),
      legacyResourceSummaries: [
        ...(sidebar?.querySelectorAll(
          '[data-sidebar="footer"] > [data-resources-sidebar]',
        ) ?? []),
      ].map((element) => ({
        display: getComputedStyle(element).display,
        ...bounds(element),
      })),
      resourceText: text,
      footer: footer
        ? {
            ...bounds(footer),
            scrollHeight: footer.scrollHeight,
            clientHeight: footer.clientHeight,
            keyboardFocusable: footer.tabIndex >= 0,
          }
        : null,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  });
}

export function assertRailReadingsLayout(measurement) {
  const failures = [];
  const { rail, resources, gauges, resourceText, footer } = measurement;

  if (rail.width < 56 || rail.width > 60)
    failures.push(`Rail width ${rail.width}px must stay between 56px and 60px`);

  if (gauges.length === 0)
    failures.push("Live usage gauges must remain visible");

  if (!resources) failures.push("Live resource counts must remain visible");

  if (
    measurement.hasLiveResources &&
    measurement.legacyResourceSummaries.some(
      (summary) => summary.display !== "none",
    )
  )
    failures.push(
      "The legacy Resources summary duplicates the live rail readings",
    );

  for (const item of gauges) {
    const { gauge, value } = item;

    if (gauge.width < 24 || gauge.width > 28 || gauge.height !== gauge.width)
      failures.push(
        `${item.label}: gauge is ${gauge.width}x${gauge.height}px instead of a 24-28px circle`,
      );

    if (gauge.x < rail.x || gauge.right > rail.right)
      failures.push(`${item.label}: gauge leaves the rail`);

    if (value.width > gauge.width * 0.78)
      failures.push(
        `${item.label}: reading is ${value.width}px wide inside a ${gauge.width}px ring`,
      );

    if (
      Math.abs(value.y + value.height / 2 - (gauge.y + gauge.height / 2)) > 1.5
    )
      failures.push(`${item.label}: reading is not centered in its ring`);

    if (item.fontSize < 10 || item.fontSize > 12.5)
      failures.push(`${item.label}: reading size is ${item.fontSize}px`);

    const partner = gauges.find(
      (other) =>
        other !== item && other.group === item.group && other.row === item.row,
    );

    if (partner && Math.abs(partner.gauge.y - gauge.y) > 1)
      failures.push(`${item.label}: paired account gauges must share a row`);
  }

  if (resources?.height > 120)
    failures.push(`Resources uses ${resources.height}px vertically`);

  for (const item of resourceText) {
    if (
      item.lines > item.clamp ||
      item.x < resources.x - 1 ||
      item.right > resources.right + 1
    )
      failures.push(`Resource label ${item.text} wraps or overflows`);

    if (item.fontSize < 10 || item.fontSize > 12.5)
      failures.push(`Resource label ${item.text} is ${item.fontSize}px`);
  }

  if (!footer?.keyboardFocusable)
    failures.push("The readings scroll area must accept keyboard focus");

  if (measurement.documentWidth > measurement.viewportWidth + 1)
    failures.push("The page overflows horizontally");

  assert.deepEqual(failures, [], failures.join("\n"));
}
