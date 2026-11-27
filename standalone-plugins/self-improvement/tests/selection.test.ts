import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  captureSelection,
  pickTarget,
  selectionName,
  visibleText,
  withSelectionContext,
} from "../selection";

const dom = new JSDOM(
  '<body><section><span>Visible label</span><input value="private password"><textarea>private draft</textarea><div contenteditable="true">private editor</div><span hidden>hidden text</span></section></body>',
);

Object.assign(globalThis, {
  NodeFilter: dom.window.NodeFilter,
  getComputedStyle: dom.window.getComputedStyle,
  innerWidth: 1000,
  innerHeight: 800,
});

const rect = {
  x: 20,
  y: 30,
  left: 20,
  top: 30,
  right: 220,
  bottom: 70,
  width: 200,
  height: 40,
  toJSON() {
    return {};
  },
};

for (const element of dom.window.document.querySelectorAll("*")) {
  element.getClientRects = () => ({
    0: rect,
    length: 1,
    item: () => rect,
    [Symbol.iterator]: () => [rect][Symbol.iterator](),
  });
  element.getBoundingClientRect = () => rect;
}

const section = dom.window.document.querySelector("section");

assert(section);

test("selection includes visible context while excluding form and editable content", () => {
  assert.equal(visibleText(section), "Visible label");
  const selected = captureSelection(section, "/threads/example", "thr_example");

  const input = withSelectionContext(
    [{ type: "text", text: "Make this label bolder", mentions: [] }],
    selected,
  );

  const prompt = input.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.equal(input[0]?.type === "text" && input[0].text, "Make this label bolder");
  assert.match(
    prompt,
    /^Make this label bolder\n\nChange this element in Omnyo as requested above\./,
  );
  assert.match(prompt, /not Omnyo's source code.*omnyo-plugin-authoring skill/);
  assert.match(prompt, /Visible label/);
  assert.match(prompt, /thr_example/);
  assert.doesNotMatch(prompt, /private|hidden text|password/);
  assert.equal(selected.rect.width, 200);
});

test("selection name prefers the accessible label and stays short", () => {
  const button = dom.window.document.createElement("button");
  button.textContent = "x".repeat(200);
  button.getBoundingClientRect = () => rect;
  section.append(button);
  assert.equal(selectionName(captureSelection(button, "/", null)), `${"x".repeat(79)}…`);
  button.setAttribute("aria-label", "Report a bug");
  assert.equal(selectionName(captureSelection(button, "/", null)), "Report a bug");
  button.remove();
});

test("picking an icon glyph selects the control that owns it", () => {
  const button = dom.window.document.createElement("button");
  button.setAttribute("aria-label", "Mobile apps");
  button.innerHTML = '<svg aria-hidden="true"><path d="M0 0h1"/></svg>';
  section.append(button);
  const path = button.querySelector("path");
  assert(path);
  assert.equal(pickTarget(path), button);
  assert.equal(pickTarget(section), section);
  button.remove();
});

test("disconnected elements cannot be captured", () => {
  const detached = dom.window.document.createElement("button");
  detached.getBoundingClientRect = () => rect;
  assert.throws(() => captureSelection(detached, "/", null), /no longer visible/);
});

test("editable element itself never contributes its label or text", () => {
  const editor = dom.window.document.querySelector("textarea");
  assert(editor);
  editor.setAttribute("aria-label", "private value");
  const selected = captureSelection(editor, "/", null);
  assert.equal(selected.text, "");
  assert.equal(selected.label, "");
});
