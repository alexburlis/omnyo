// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import {
  applyPluginCss,
  retainPluginCss,
  resetPluginCssForTest,
} from "./plugin-css";

import {
  dropHostDuplicatePluginRules,
  normalizePluginStylesheet,
} from "./plugin-css-selectors";

const scope =
  ':where([data-omnyo-plugin="demo"], [data-omnyo-plugin-root]:not([data-omnyo-plugin]))';

function selector(sheet: CSSStyleSheet): string {
  const rule = sheet.cssRules[0];

  if (
    !rule ||
    !("selectorText" in rule) ||
    typeof rule.selectorText !== "string"
  )
    throw new Error("Expected a style rule");

  return rule.selectorText;
}

afterEach(() => {
  resetPluginCssForTest();
  document.body.replaceChildren();
});

it("anchors loaded plugin variants without changing attributed, preview or host matches", () => {
  document.body.innerHTML =
    '<div id="self" data-omnyo-plugin="demo" class="target" data-open><button id="own" class="target" data-open></button></div><div data-omnyo-plugin-root><button id="preview" class="target" data-open></button></div><div data-omnyo-plugin="other"><button id="other" class="target" data-open></button></div><button id="host" class="target" data-open></button>';
  const sheet = new CSSStyleSheet();
  sheet.insertRule(
    `:is(${scope} .target, ${scope}.target)[data-open] { color: red; }`,
  );

  const before = [...document.querySelectorAll(selector(sheet))].map(
    (e) => e.id,
  );

  expect(before).toEqual(["self", "own", "preview"]);
  applyPluginCss("demo", "/demo.css");
  retainPluginCss("demo");

  const link = document.head.querySelector(
    'link[data-omnyo-plugin-css="demo"]',
  );

  if (!link) throw new Error("Expected the active plugin stylesheet");
  Object.defineProperty(link, "sheet", { value: sheet });
  link.dispatchEvent(new Event("load"));
  expect(selector(sheet)).not.toContain(":is(");
  expect(selector(sheet)).not.toContain(scope);
  expect(
    [...document.querySelectorAll(selector(sheet))].map((e) => e.id),
  ).toEqual(before);
});

it("keeps escaped commas and quoted parentheses within a selector", () => {
  const sheet = new CSSStyleSheet();
  const target = String.raw`.target\,odd[data-label="a,b)"]`;
  sheet.insertRule(
    `:is(${scope} ${target}, ${scope}${target}):not([data-hidden="x,y"]) { color: red; }`,
  );
  expect(normalizePluginStylesheet(sheet, "demo")).toBe(1);
  expect(selector(sheet)).not.toContain(":is(");
  expect(selector(sheet).split(target)).toHaveLength(5);
  expect(selector(sheet).split(':not([data-hidden="x,y"])')).toHaveLength(5);
});

it("preserves conditional rules and keyframes", () => {
  const sheet = new CSSStyleSheet();
  sheet.insertRule(
    `@media (hover: hover) { :is(${scope} .target, ${scope}.target):hover { color: red; } }`,
  );
  sheet.insertRule(
    "@keyframes demo { from { opacity: 0; } to { opacity: 1; } }",
    1,
  );
  const animation = sheet.cssRules[1]?.cssText;
  expect(normalizePluginStylesheet(sheet, "demo")).toBe(1);
  expect(sheet.cssRules[0]?.cssText).toContain("@media (hover: hover)");
  expect(sheet.cssRules[0]?.cssText).not.toContain(":is(");
  expect(sheet.cssRules[1]?.cssText).toBe(animation);
});

it.each([
  `:is(${scope} .target, ${scope}#specific):hover`,
  `:is(${scope} .target, ${scope}.target, ${scope} .other):hover`,
  `${scope} .target:is(${scope} .other)`,
  ".host,.other",
  `:is(${scope} .target::before, ${scope}.target::before)`,
])(
  "leaves selectors with a different specificity or scope contract intact: %s",
  (original) => {
    const sheet = new CSSStyleSheet();
    sheet.insertRule(`${original} { color: red; }`);
    const before = selector(sheet);
    expect(normalizePluginStylesheet(sheet, "demo")).toBe(0);
    expect(selector(sheet)).toBe(before);
  },
);

it("keeps sibling matches inside their original plugin root", () => {
  document.body.innerHTML =
    '<div data-omnyo-plugin="demo"><i class="trigger"></i><b id="own" class="target"></b></div><b id="host" class="target"></b>';
  const sheet = new CSSStyleSheet();
  sheet.insertRule(`${scope} .trigger ~ .target { color: red; }`);

  const before = [...document.querySelectorAll(selector(sheet))].map(
    (e) => e.id,
  );

  expect(before).toEqual(["own"]);
  expect(normalizePluginStylesheet(sheet, "demo")).toBe(1);
  expect(
    [...document.querySelectorAll(selector(sheet))].map((e) => e.id),
  ).toEqual(before);
});

it("does not expand an already normalized stylesheet again", () => {
  const sheet = new CSSStyleSheet();
  sheet.insertRule(
    `:is(${scope} .target, ${scope}.target):hover { color: red; }`,
  );
  expect(normalizePluginStylesheet(sheet, "demo")).toBe(1);
  const before = selector(sheet);
  expect(normalizePluginStylesheet(sheet, "demo")).toBe(0);
  expect(selector(sheet)).toBe(before);
});

it("drops plugin utilities that repeat a host rule under the same conditions", () => {
  const host = new CSSStyleSheet();
  host.insertRule(".flex { display: flex; }");
  host.insertRule("@media (hover: hover) { .tint:hover { color: red; } }", 1);
  host.insertRule(".pad { padding: 4px; }", 2);
  host.insertRule(".gap { gap: 2px; }", 3);
  const attributed = ':where([data-omnyo-plugin="demo"])';
  const preview = ":where([data-omnyo-plugin-root]:not([data-omnyo-plugin]))";
  const sheet = new CSSStyleSheet();

  for (const [index, rule] of [
    `${attributed} .flex, ${preview} .flex, ${attributed}.flex, ${preview}.flex { display: flex; }`,
    `@media (hover: hover) { ${attributed} .tint:hover, ${preview} .tint:hover { color: red; } }`,
    `${attributed} .pad, ${preview} .pad { padding: 8px; }`,
    `@media (width >= 40rem) { ${attributed} .gap, ${preview} .gap { gap: 2px; } }`,
    `${attributed} .flex, ${preview} .grid { display: flex; }`,
    ':where([data-omnyo-plugin="other"]) .flex { display: flex; }',
  ].entries())
    sheet.insertRule(rule, index);

  expect(dropHostDuplicatePluginRules(sheet, "demo", [host])).toBe(2);
  expect(
    [...sheet.cssRules].map((rule) => rule.cssText.replace(/\s+/g, " ")),
  ).toEqual([
    "@media (hover: hover) { }",
    expect.stringContaining("padding: 8px"),
    expect.stringContaining("@media (width >= 40rem)"),
    expect.stringContaining(".grid"),
    expect.stringContaining('[data-omnyo-plugin="other"]'),
  ]);
});

it("keeps plugin utilities when the host defines the selector inconsistently", () => {
  const host = new CSSStyleSheet();
  host.insertRule(".flex { display: flex; }");
  host.insertRule(".flex { display: block; }", 1);
  const sheet = new CSSStyleSheet();
  sheet.insertRule(
    ':where([data-omnyo-plugin="demo"]) .flex { display: flex; }',
  );

  expect(dropHostDuplicatePluginRules(sheet, "demo", [host])).toBe(0);
  expect(sheet.cssRules).toHaveLength(1);
});

const tintFallback = `:where([data-omnyo-plugin="demo"]) .tint\\/15, :where([data-omnyo-plugin-root]:not([data-omnyo-plugin])) .tint\\/15 { color: red; }`;

const tintOverride = `@media (hover: hover) { :where([data-omnyo-plugin="demo"]) .tint\\/15, :where([data-omnyo-plugin-root]:not([data-omnyo-plugin])) .tint\\/15 { color: blue; } }`;

function remainingRules(sheet: CSSStyleSheet): string[] {
  return [...sheet.cssRules].map((rule) => rule.cssText.replace(/\s+/g, " "));
}

it("drops a plugin fallback and its override together when the host merges the fallback with another selector", () => {
  const host = new CSSStyleSheet();
  host.insertRule(".tint, .tint\\/15 { color: red; }");
  host.insertRule("@media (hover: hover) { .tint\\/15 { color: blue; } }", 1);
  const sheet = new CSSStyleSheet();
  sheet.insertRule(tintFallback);
  sheet.insertRule(tintOverride, 1);

  expect(dropHostDuplicatePluginRules(sheet, "demo", [host])).toBe(2);
  expect(remainingRules(sheet)).toEqual(["@media (hover: hover) { }"]);
});

it("keeps a plugin override that the host repeats while the plugin's earlier rule for that selector stays", () => {
  const host = new CSSStyleSheet();
  host.insertRule("@media (hover: hover) { .tint\\/15 { color: blue; } }");
  const sheet = new CSSStyleSheet();
  sheet.insertRule(tintFallback);
  sheet.insertRule(tintOverride, 1);

  expect(dropHostDuplicatePluginRules(sheet, "demo", [host])).toBe(0);
  expect(remainingRules(sheet)).toEqual([
    expect.stringContaining("color: red"),
    expect.stringContaining("color: blue"),
  ]);
});
