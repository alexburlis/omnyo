import { afterEach, describe, expect, test } from "vitest";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { stateMachinesRpc } from "../src/contracts/rpc.js";
import { runDecisionPayloadSchema } from "../src/contracts/run-decision.js";
import { HomeQuestions } from "../src/home-questions.js";
import { createStateMachineRpcHandlers } from "../src/rpc.js";
import { publish, setup, signal } from "./runtime-fixtures.js";

type RequestInput = PluginApi["ui"]["requestInput"];

type InteractionResult = Awaited<ReturnType<RequestInput>>;

const fixtures: ReturnType<typeof setup>[] = [];

const stops: AbortController[] = [];

function fixture() {
  const f = setup();
  fixtures.push(f);

  const handlers = createStateMachineRpcHandlers(f.service, {
    listEnvironments: async () => [],
  });

  return { ...f, handlers };
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort();

  for (const f of fixtures.splice(0)) f.database.close();
});

async function failCheck(f: ReturnType<typeof fixture>, instanceId: string, reason: string) {
  signal(f.service, instanceId);
  await f.service.tick();
  const invocation = f.adapter.starts.at(-1)!;
  f.adapter.settle(invocation, {
    status: "quiescent",
    confirmedLive: false,
    result: { type: "failed", payload: { exitCode: 2, reason } },
  });
  f.advance();
  await f.service.tick();

  return invocation;
}

async function attention(f: ReturnType<typeof fixture>, instanceId: string) {
  const parsed = stateMachinesRpc.sm_attention_list.output.parse(
    await f.handlers.sm_attention_list({ machineId: null, instanceId }),
  );

  if (!parsed.ok) throw new Error(parsed.error.message);

  return parsed.value;
}

function fakeUi() {
  const requests: {
    request: Parameters<RequestInput>[0];
    signal: AbortSignal | undefined;
    answer: (result: InteractionResult) => void;
  }[] = [];

  const ui: Pick<PluginApi["ui"], "requestInput"> = {
    requestInput: (request, options) =>
      new Promise<InteractionResult>((resolve) => {
        requests.push({ request, signal: options?.signal, answer: resolve });
        options?.signal?.addEventListener("abort", () =>
          resolve({ outcome: "cancelled", reason: "request-aborted" }),
        );
      }),
  };

  return { ui, requests };
}

async function settled() {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("run home chats", () => {
  test("start creates one home chat and every step reports to it", async () => {
    const f = fixture();
    const { instance } = await publish(f, undefined, { kind: "new", title: null });

    expect(f.adapter.homes).toEqual([
      expect.objectContaining({
        instanceId: instance.instanceId,
        machineName: "Local check loop",
        requestId: "start",
      }),
    ]);
    expect(instance.homeThreadId).toBe("home-1");

    signal(f.service, instance.instanceId);
    await f.service.tick();

    expect(f.adapter.starts.at(-1)?.homeThreadId).toBe("home-1");
  });

  test("rejects a home chat the adapter reports as unusable", async () => {
    const f = fixture();
    f.adapter.homeProblem = "Choose a visible chat: hidden chats can't hold questions.";

    await expect(
      publish(f, undefined, { kind: "thread", threadId: "thr_hidden" }),
    ).rejects.toMatchObject({
      code: "HOME_THREAD_INVALID",
      message: "Choose a visible chat: hidden chats can't hold questions.",
    });
  });

  test("a gate opened by a failed step says what failed and where it leads", async () => {
    const f = fixture();
    const { instance } = await publish(f);
    const invocation = await failCheck(f, instance.instanceId, "ls exited with code 2");
    const [gate] = await attention(f, instance.instanceId);

    expect(gate).toMatchObject({
      kind: "gate",
      title: "Needs a person",
      homeThreadId: null,
      cause: {
        stateId: "check",
        stateTitle: "Check workspace",
        outcome: "failed",
        reason: "ls exited with code 2",
        invocationId: invocation.invocationId,
      },
    });
    expect(gate?.decisions.map((decision) => decision.targetTitle)).toEqual(
      expect.arrayContaining(["Check workspace", "Waiting for the next check"]),
    );
  });

  test("a decision that only routes through a choice step names no target", async () => {
    const f = fixture();

    const { instance } = await publish(f, (definition) => ({
      ...definition,
      states: [
        ...definition.states,
        { id: "route-retry", kind: "choice", title: "Route the retry", subtitle: "" },
      ],
      transitions: [
        ...definition.transitions.map((transition) =>
          transition.id === "tr_check_retry" ? { ...transition, to: "route-retry" } : transition,
        ),
        {
          id: "tr_route_retry",
          from: "route-retry",
          to: "check",
          trigger: { kind: "always" },
          guard: null,
          contextPatch: [],
          priority: 0,
        },
      ],
    }));

    await failCheck(f, instance.instanceId, "ls exited with code 2");
    const [gate] = await attention(f, instance.instanceId);

    expect(
      Object.fromEntries(
        gate?.decisions.map((decision) => [decision.name, decision.targetTitle]) ?? [],
      ),
    ).toMatchObject({ "retry-check": null, "resume-waiting": "Waiting for the next check" });
  });

  test("the log calls a step start a step and a gate a decision, not problems", async () => {
    const f = fixture();
    const { instance } = await publish(f);
    await failCheck(f, instance.instanceId, "ls exited with code 2");

    const page = stateMachinesRpc.sm_history_list.output.parse(
      await f.handlers.sm_history_list({
        instanceId: instance.instanceId,
        before: null,
        limit: 100,
        kinds: [],
      }),
    );

    if (!page.ok) throw new Error(page.error.message);

    expect(page.value.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "step", text: "Step started", problem: false }),
        expect.objectContaining({
          kind: "decision",
          text: "Waiting for your decision",
          problem: false,
        }),
      ]),
    );
    expect(page.value.entries.some((entry) => entry.text === "dispatch")).toBe(false);
  });
});

describe("home chat questions", () => {
  test("opens each gate as a form in the home chat and applies the answer", async () => {
    const f = fixture();
    const { instance } = await publish(f, undefined, { kind: "new", title: null });
    await failCheck(f, instance.instanceId, "ls exited with code 2");
    const { ui, requests } = fakeUi();
    const stop = new AbortController();
    stops.push(stop);
    void new HomeQuestions(ui, { warn: () => undefined }, f.service).run(stop.signal);

    expect(requests).toHaveLength(1);
    const [form] = requests;

    expect(form?.request).toMatchObject({ threadId: "home-1", rendererId: "run-decision" });

    const payload = runDecisionPayloadSchema.parse(form?.request.payload);

    expect(payload.cause?.reason).toBe("ls exited with code 2");

    form?.answer({
      outcome: "submitted",
      value: { decision: "resume-waiting", evidence: "Fixed the directory permissions." },
    });
    await settled();

    expect(await attention(f, instance.instanceId)).toEqual([]);
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).stateId).toBe("waiting");
  });

  test("withdraws the form when the gate is decided somewhere else", async () => {
    const f = fixture();
    const { instance } = await publish(f, undefined, { kind: "new", title: null });
    await failCheck(f, instance.instanceId, "ls exited with code 2");
    const { ui, requests } = fakeUi();
    const stop = new AbortController();
    stops.push(stop);
    const questions = new HomeQuestions(ui, { warn: () => undefined }, f.service);
    void questions.run(stop.signal);
    const [gate] = await attention(f, instance.instanceId);

    await f.service.resolveAttention({
      instanceId: instance.instanceId,
      attentionId: gate!.attentionId,
      entryId: gate!.entryId,
      expectedRevision: gate!.revision,
      decision: "resume-waiting",
      evidence: "Handled in the panel.",
      requestId: "panel",
    });
    questions.sync();

    expect(requests[0]?.signal?.aborted).toBe(true);
    await settled();
    expect(requests).toHaveLength(1);
  });

  test("keeps runs without a home chat in the panel only", async () => {
    const f = fixture();
    const { instance } = await publish(f);
    await failCheck(f, instance.instanceId, "ls exited with code 2");
    const { ui, requests } = fakeUi();
    const stop = new AbortController();
    stops.push(stop);
    void new HomeQuestions(ui, { warn: () => undefined }, f.service).run(stop.signal);

    expect(requests).toEqual([]);
    expect(await attention(f, instance.instanceId)).toHaveLength(1);
  });
});
