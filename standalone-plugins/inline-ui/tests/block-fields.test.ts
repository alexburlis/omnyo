import assert from "node:assert/strict";
import { test } from "node:test";
import { calloutProblem, readTone } from "../block-fields.ts";
import { parseRecordFence } from "../record-fields.ts";

test("every block shares one tone vocabulary with documented aliases", () => {
  for (const tone of ["neutral", "info", "positive", "warning", "negative", "muted"]) {
    assert.equal(readTone(tone), tone);
  }

  assert.equal(readTone("success"), "positive");
  assert.equal(readTone("error"), "negative");
  assert.equal(readTone("note"), "info");
  assert.equal(readTone("Danger"), "negative");
});

test("an unknown or missing tone falls back instead of failing", () => {
  assert.equal(readTone("sparkly"), "neutral");
  assert.equal(readTone(undefined, "info"), "info");
  assert.equal(readTone("  ", "info"), "info");
});

test("the agent's status table with success tones parses", () => {
  const result = parseRecordFence(
    "status-table",
    '::status-table{labels="Canvas features (sections, views, canvas chats, sidebar row)|iPhone-size layout in iOS Simulator Safari|Smoothness at 60 fps" values="Done and live|Passed|Not measured" tones="success|success|warning"}',
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
});

test("a callout renders from its title alone and ignores unknown fields and tones", () => {
  assert.equal(calloutProblem({ tone: "info", title: "Your 30-second check" }), null);
  assert.equal(calloutProblem({ text: "Hi", tone: "danger", body: "x" }), null);
  assert.match(calloutProblem({ tone: "info" }) ?? "", /it has no text/u);
});
