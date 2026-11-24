import golden from "../workflow-fixtures/weekly-content-feed.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { inspectWorkflowPackage } from "./workflow-package.js";

const pkg = {
  schemaVersion: 1,
  revision: 1,
  title: "Mosslight Workshop",
  description: "Fictional setup",
  inputs: [
    {
      id: "startup",
      label: "Startup",
      type: "text",
      default: "Mosslight Workshop",
    },
  ],
  trigger: { kind: "manual" },
  flow: {
    kind: "graph",
    engine: "restricted",
    startStepId: "draft",
    steps: [
      {
        kind: "model",
        id: "draft",
        prompt: "Use supplied evidence.",
        nextStepId: "export",
      },
      { kind: "export", id: "export" },
    ],
  },
  skills: [
    {
      id: "mosslight.draft",
      title: "Draft",
      body: "Use only the supplied facts.",
    },
  ],
  layout: [{ stepId: "draft", x: 10, y: 20 }],
};

const encode = (input: string) => new TextEncoder().encode(input);

const inspect = (input: unknown) =>
  inspectWorkflowPackage(encode(JSON.stringify(input)));

describe("portable workflow package", () => {
  it("shares the Weekly Content Feed digests with the execution owner", async () => {
    const result = await inspect(golden);
    expect(result.packageDigest).toBe(
      "95c025bcf1ad32734e69fd000ca17abcba70b5508a8a57c760456d566133e5c5",
    );
    expect(result.executionDigest).toBe(
      "db57516adbc126d4a0817f6e056975d2a9417668d146bfd8cd340cff83260725",
    );
  });

  it("pins canonical and executable digests separately", async () => {
    const original = await inspect(pkg);

    const res = await inspect({
      ...pkg,
      layout: [{ stepId: "draft", x: 11, y: 20 }],
      senderLabel: "Unverified",
    });

    expect(res.packageDigest).not.toBe(original.packageDigest);
    expect(res.executionDigest).toBe(original.executionDigest);
    expect(
      (await inspectWorkflowPackage(original.canonicalBytes)).packageDigest,
    ).toBe(original.packageDigest);
    expect(
      (
        await inspect({
          ...pkg,
          skills: [{ ...pkg.skills[0], body: "Changed rules." }],
        })
      ).executionDigest,
    ).not.toBe(original.executionDigest);
  });

  it.each([
    { ...pkg, shell: "unexpected" },
    { ...pkg, flow: { kind: "command", path: "/tmp/task" } },
    {
      ...pkg,
      skills: [{ ...pkg.skills[0], body: "---\nallowed-tools: Bash\n---" }],
    },
    { ...pkg, skills: [{ ...pkg.skills[0], body: "Run $(anything)" }] },
    { ...pkg, skills: [{ ...pkg.skills[0], id: "../draft" }] },
    { ...pkg, skills: [...pkg.skills, ...pkg.skills] },
    { ...pkg, layout: [{ stepId: "absent", x: 0, y: 0 }] },
    { ...pkg, inputs: [{ ...pkg.inputs[0], default: "\ud800" }] },
  ])("rejects a malformed or unsafe portable document", async (input) => {
    await expect(inspect(input)).rejects.toThrow();
  });

  it("rejects duplicate escaped JSON keys before canonicalization", async () => {
    const text = JSON.stringify(pkg).replace(
      '"revision":1',
      '"revision":1,"revi\\u0073ion":2',
    );

    await expect(inspectWorkflowPackage(encode(text))).rejects.toThrow(
      "duplicate JSON key",
    );
  });
});
