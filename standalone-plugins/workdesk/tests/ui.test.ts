import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { act, fireEvent, waitFor } from "@testing-library/react";
import plugin from "../server";
import type { rpcContract } from "../server";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
for (const name of [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "NodeFilter",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "DocumentFragment",
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (dom.window as any)[name],
  });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: dom.window.getComputedStyle,
});
dom.window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return true;
  },
  media: "",
  onchange: null,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (fn: () => void) => setTimeout(fn, 0),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: clearTimeout,
});
const app = await loadPluginApp(() => import("../views"));
async function setup(t: { after: (fn: () => void | Promise<void>) => void }) {
  const h = createFakePluginHost({
    pluginId: "workdesk",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({
            id: "source-a",
            projectId: "project-a",
            title: "Release approval",
          }),
      },
      projects: { get: async () => ({ id: "project-a", name: "Nimbus" }) },
    },
  });
  await plugin(h.api);
  t.after(() => h.harness.lifecycle.dispose());
  const action = JSON.parse(
    (await h.harness.behavior.callAgentTool(
      "workdesk_report",
      {
        kind: "action",
        key: "approve-v24",
        area: "Mac release",
        summary:
          "Approve v2.4 website and updater publication; release is blocked.",
        reason: "Only Sam can approve production publication.",
        priority: 1,
      },
      { threadId: "source-a" },
    )) as string,
  );
  const rpc: any = Object.fromEntries(
    ["list", "overview", "edit", "decide"].map((method) => [
      method,
      (input: unknown) => h.harness.behavior.callRpc(method, input),
    ]),
  );
  return { h, action, rpc };
}
test("overview supports priority override, completion and archived source navigation", async (t) => {
  const { h, action, rpc } = await setup(t);
  await h.harness.behavior.emitThreadEvent("thread.archived", {
    thread: makeThreadResponse({ id: "source-a" }),
  });
  const view = renderSlot(app.navPanels[0], { subPath: "" }, { rpc });
  t.after(() => view.unmount());
  await view.findByText(action.summary);
  assert.ok(view.getByText("P1", { selector: "span.wd-priority" }));
  fireEvent.click(view.getByText(action.summary));
  fireEvent.change(view.getByLabelText(`Priority for ${action.summary}`), {
    target: { value: "3" },
  });
  await waitFor(() =>
    assert.ok(view.getByText("P3", { selector: "span.wd-priority" })),
  );
  fireEvent.click(view.getByRole("button", { name: /Open chat/ }));
  assert.deepEqual(view.navigateCalls.at(-1), {
    method: "toThread",
    threadId: "source-a",
  });
  fireEvent.click(
    view.getByRole("button", { name: `Complete: ${action.summary}` }),
  );
  await waitFor(() => assert.ok(view.getByText("No actions in this view.")));
  fireEvent.change(view.getByLabelText("Action status"), {
    target: { value: "done" },
  });
  await view.findByText(action.summary);
});
test("reconnection refreshes missed changes and project filters send scoped queries", async (t) => {
  const { h, rpc } = await setup(t);
  const view = renderSlot(app.navPanels[0], { subPath: "" }, { rpc });
  t.after(() => view.unmount());
  await view.findByText(/Approve v2.4/);
  await view.behavior.setRealtimeConnectionState("reconnecting");
  await h.harness.behavior.callAgentTool(
    "workdesk_report",
    {
      kind: "work",
      key: "verified-sync",
      area: "Sync",
      summary: "Verified reconnect on the physical iPhone.",
      outcome: "verified",
      evidence: "Physical iPhone 14 Pro reconnect succeeded.",
    },
    { threadId: "source-a" },
  );
  await view.behavior.setRealtimeConnectionState("connected");
  await view.findByText("Verified reconnect on the physical iPhone.");
  fireEvent.change(view.getByLabelText("Project"), {
    target: { value: "project-a" },
  });
  await waitFor(() =>
    assert.ok(
      view.rpcCalls.some(
        (c: any) => c.method === "list" && c.input.projectId === "project-a",
      ),
    ),
  );
});
test("sidebar footer opens the drawer without a floating launcher and navigates to the overview", async (t) => {
  const { action, rpc } = await setup(t);
  const view = renderSlot(app.appOverlays[0], {}, { rpc });
  t.after(() => view.unmount());
  assert.equal(view.container.querySelector(".wd-global, .wd-launcher"), null);
  assert.equal(view.queryByRole("button"), null);
  const footer = app.sidebarFooterActions.find(
    (action) => action.id === "actions",
  )!;
  assert.equal(footer.title, "Your actions");
  await act(async () => {
    await footer.run({ openSettings() {} });
  });
  await view.findByRole("dialog");
  await view.findByText(action.summary);
  fireEvent.click(view.getByRole("button", { name: "Open Workdesk" }));
  assert.deepEqual(view.navigateCalls.at(-1), {
    method: "toPluginPanel",
    path: "overview",
  });
});

test("chat resolution updates open dashboard; dashboard reopen returns to fresh chat context", async (t) => {
  const { h, action, rpc } = await setup(t);
  const page = renderSlot(app.navPanels[0], { subPath: "" }, { rpc });
  t.after(() => page.unmount());
  await page.findByText(action.summary);
  const evidence =
    "Sam approved v2.4 website and updater publication in the source chat.";
  await h.harness.behavior.callAgentTool(
    "workdesk_resolve",
    { id: action.id, revision: action.revision, evidence },
    { threadId: "source-a" },
  );
  assert.ok(
    h.harness.inspection.realtimeSignals.some((s) => s.channel === "changed"),
  );
  await page.behavior.emitRealtime("changed", {});
  await page.findByText("No actions in this view.");
  fireEvent.change(page.getByLabelText("Action status"), {
    target: { value: "done" },
  });
  await page.findByText(action.summary);
  fireEvent.click(page.getByText(action.summary));
  await page.findByText(evidence);
  fireEvent.click(page.getByRole("button", { name: "Reopen" }));
  await page.findByText("No actions in this view.");
  const context = JSON.parse(
    (await h.harness.behavior.callAgentTool(
      "workdesk_context",
      {},
      { threadId: "source-a" },
    )) as string,
  );
  assert.equal(context.items[0].status, "open");
  assert.equal(context.items[0].resolution, null);
});

test("approval controls deliver the scoped choice and remove it from the open inbox", async (t) => {
  const { h, rpc } = await setup(t);
  const summary = "Approve exact v2.5 release to the website only.";
  await h.harness.behavior.callAgentTool(
    "workdesk_report",
    {
      kind: "action",
      key: "approval-v25",
      area: "Release",
      summary,
      reason: "Publication requires Sam",
      approval: true,
    },
    { threadId: "source-a" },
  );
  h.harness.inspection.sdk.stub("threads.send", () => ({
    ok: true,
    delivery: "sent",
  }));
  const view = renderSlot(app.navPanels[0], { subPath: "" }, { rpc });
  t.after(() => view.unmount());
  await view.findByText(summary);
  assert.ok(view.getByRole("button", { name: `Decline: ${summary}` }));
  assert.equal(
    view.queryByRole("button", { name: `Complete: ${summary}` }),
    null,
  );
  fireEvent.click(view.getByRole("button", { name: `Approve: ${summary}` }));
  await waitFor(() => assert.ok(!view.queryByText(summary)));
  const calls = h.harness.inspection.sdk.callsTo("threads.send");
  assert.equal(calls.length, 1);
  fireEvent.change(view.getByLabelText("Action status"), {
    target: { value: "done" },
  });
  await view.findByText(summary);
  await view.findByText("Approved");
});

test("decline removes the card and updates counts and drawer without a realtime event", async (t) => {
  const { h, rpc } = await setup(t);
  const summary = "Publish v2.5 website release";
  await h.harness.behavior.callAgentTool(
    "workdesk_report",
    {
      kind: "action",
      key: "silent-decline",
      area: "Release",
      summary,
      reason: "Publication needs approval",
      approval: true,
    },
    { threadId: "source-a" },
  );
  const page = renderSlot(app.navPanels[0], { subPath: "" }, { rpc });
  t.after(() => page.unmount());
  await page.findByText(summary);
  assert.equal(page.container.querySelector(".wd-status b")?.textContent, "2");
  fireEvent.click(page.getByRole("button", { name: `Decline: ${summary}` }));
  await waitFor(() => {
    assert.ok(!page.queryByText(summary));
    assert.equal(
      page.container.querySelector(".wd-status b")?.textContent,
      "1",
    );
  });
  assert.equal(h.harness.inspection.sdk.callsTo("threads.send").length, 0);
  assert.equal(h.harness.inspection.sdk.callsTo("threads.unarchive").length, 0);
  page.unmount();
  const drawer = renderSlot(app.appOverlays[0], {}, { rpc });
  t.after(() => drawer.unmount());
  await act(async () => {
    await app.sidebarFooterActions[0].run({ openSettings() {} });
  });
  await drawer.findByRole("dialog");
  await waitFor(() =>
    assert.equal(
      drawer.getByRole("dialog").querySelectorAll(".wd-card").length,
      1,
    ),
  );
  assert.ok(!drawer.queryByText(summary));
});

test("returning to Workdesk refreshes missed edits and long notes use bounded bullets", async (t) => {
  const { h, action, rpc } = await setup(t);
  const note =
    "Confirm the existing account settings. " +
    "Detailed supporting context. ".repeat(30);
  const db = h.api.storage.database();
  db.prepare(
    "UPDATE records SET data=json_set(data,'$.details',?) WHERE id=?",
  ).run(note, action.id);
  const page = renderSlot(app.navPanels[0], { subPath: "" }, { rpc });
  t.after(() => page.unmount());
  await page.findByText(action.summary);
  assert.ok(
    (page.container.querySelector(".wd-notes")?.textContent?.length ?? 1000) <
      note.length * 0.2,
  );
  assert.ok(
    page.container
      .querySelector(".wd-full-notes .wd-pre")
      ?.textContent?.includes(note),
  );
  assert.equal(
    page.container.querySelector(".wd-full-notes")?.hasAttribute("open"),
    false,
  );
  await h.harness.behavior.callRpc("edit", {
    id: action.id,
    operation: "done",
  });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await page.findByText("No actions in this view.");
  assert.equal(page.container.querySelector(".wd-status b")?.textContent, "0");
});
