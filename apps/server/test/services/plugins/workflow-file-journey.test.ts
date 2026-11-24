import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PERSONAL_PROJECT_ID } from "@omnyo/domain";
import { resolveBuiltinPluginRootPath } from "../../../src/services/plugins/builtin-registry.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  startTestServer,
  type RunningTestServer,
} from "../../helpers/test-app.js";

vi.mock(
  "../../../src/services/plugins/builtin-registry.js",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../src/services/plugins/builtin-registry.js")
      >();

    return {
      ...original,
      listBundledPluginRegistrations: () =>
        original.listBundledPluginRegistrations().map((entry) => {
          const rootDir = process.env.OMNYO_WORKFLOW_GRAPH_TEST_SOURCE;

          return entry.name === "state-machines" && rootDir
            ? { ...entry, rootDir }
            : entry;
        }),
    };
  },
);

const reviewSchema = z.object({
  reviewId: z.string(),
  packageDigest: z.string(),
  executionDigest: z.string(),
  capabilities: z.array(z.string()),
});

const copySchema = z.object({
  importId: z.string(),
  projectId: z.string(),
  packageDigest: z.string(),
  executionDigest: z.string(),
  graphId: z.null(),
  graphVersion: z.null(),
  automationId: z.null(),
  bindings: z.null(),
  confirmation: z.null(),
});

const exportSchema = z.object({ text: z.string(), packageDigest: z.string() });

const source = {
  schemaVersion: 1,
  revision: 1,
  title: "Fictional founder handoff",
  description: "A portable unmet script requirement.",
  inputs: [{ id: "startup", label: "Startup name", type: "text" }],
  trigger: {
    kind: "weekly",
    weekday: 1,
    time: "09:00",
    timezone: "America/Toronto",
  },
  flow: {
    kind: "script-requirement",
    description: "Replace this requirement with a supported restricted action.",
  },
  skills: [],
};

async function response(
  server: RunningTestServer,
  method: string,
  input: unknown,
) {
  return fetch(`${server.baseUrl}/api/v1/plugins/automations/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5000),
  });
}

async function rpc(
  server: RunningTestServer,
  method: string,
  input: unknown,
): Promise<unknown> {
  const result = await response(server, method, input);
  const body: unknown = await result.json();
  expect(result.status, JSON.stringify(body)).toBe(200);

  return z.object({ result: z.unknown() }).parse(body).result;
}

async function install(server: RunningTestServer) {
  server.pluginService.bindSdk({ baseUrl: server.baseUrl });

  const installed = await server.pluginService.install("builtin:automations", {
    kind: "root",
  });

  expect(installed.status, installed.statusDetail ?? undefined).toBe("running");
}

function threads(server: RunningTestServer): unknown {
  return server.db.$client
    .prepare("SELECT COUNT(*) AS total FROM threads")
    .get();
}

async function withCoordinators(
  run: (
    sender: RunningTestServer,
    recipient: RunningTestServer,
  ) => Promise<void>,
): Promise<void> {
  const started = await Promise.allSettled([
    startTestServer({ seedFirstPartyProviders: false }),
    startTestServer({ seedFirstPartyProviders: false }),
  ]);

  const servers = started.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

  try {
    const failure = started.find((result) => result.status === "rejected");

    if (failure?.status === "rejected") throw failure.reason;
    const [sender, recipient] = servers;

    if (!sender || !recipient)
      throw new Error("Two coordinators are required.");
    expect(sender.baseUrl).not.toBe(recipient.baseUrl);
    await Promise.all(servers.map(install));
    await run(sender, recipient);
  } finally {
    await Promise.all(
      servers.map(async (server) => {
        try {
          await server.pluginService.stop();
        } finally {
          await server.close();
        }
      }),
    );
  }
}

describe("workflow file journey through two real coordinators", () => {
  it("exports, reviews, saves and replays an inert recipient copy without schedules or model calls", async () => {
    await withCoordinators(async (sender, recipient) => {
      const servers = [sender, recipient];
      const initialThreads = servers.map(threads);
      const project = { projectId: PERSONAL_PROJECT_ID };

      const senderReview = reviewSchema.parse(
        await rpc(sender, "workflow_inspect", {
          kind: "file",
          text: JSON.stringify(source),
        }),
      );

      expect(senderReview.capabilities).toEqual(["replace-script-requirement"]);

      const senderCopy = copySchema.parse(
        await rpc(sender, "workflow_install", {
          ...project,
          reviewId: senderReview.reviewId,
          packageDigest: senderReview.packageDigest,
          requestId: "sender-copy",
        }),
      );

      const exported = exportSchema.parse(
        await rpc(sender, "workflow_export", {
          ...project,
          importId: senderCopy.importId,
        }),
      );

      const recipientReview = reviewSchema.parse(
        await rpc(recipient, "workflow_inspect", {
          kind: "file",
          text: exported.text,
        }),
      );

      expect(recipientReview.packageDigest).toBe(senderReview.packageDigest);
      expect(recipientReview.executionDigest).toBe(
        senderReview.executionDigest,
      );
      expect(recipientReview.reviewId).not.toBe(senderReview.reviewId);
      expect(await rpc(recipient, "workflow_list", project)).toEqual([]);

      const installRequest = {
        ...project,
        reviewId: recipientReview.reviewId,
        packageDigest: recipientReview.packageDigest,
        requestId: "recipient-copy",
      };

      const recipientCopy = copySchema.parse(
        await rpc(recipient, "workflow_install", installRequest),
      );

      expect(recipientCopy.importId).not.toBe(senderCopy.importId);
      expect(
        copySchema.parse(
          await rpc(recipient, "workflow_install", installRequest),
        ),
      ).toEqual(recipientCopy);
      expect(await rpc(recipient, "workflow_list", project)).toEqual([
        expect.objectContaining({ importId: recipientCopy.importId }),
      ]);
      expect(await rpc(sender, "workflow_list", project)).toEqual([
        expect.objectContaining({ importId: senderCopy.importId }),
      ]);
      const target = { ...project, importId: recipientCopy.importId };
      expect(await rpc(recipient, "workflow_preview", target)).toMatchObject({
        copy: recipientCopy,
        example: expect.any(String),
      });
      expect(
        exportSchema.parse(await rpc(recipient, "workflow_export", target)),
      ).toEqual(exported);
      expect(
        (await response(recipient, "workflow_enable", target)).status,
      ).not.toBe(200);
      expect(
        (
          await response(recipient, "workflow_run", {
            ...target,
            requestId: "must-not-run",
          })
        ).status,
      ).not.toBe(200);

      for (const server of servers) {
        expect(await rpc(server, "automations_list", project)).toEqual([]);
      }

      const hostile = await response(recipient, "workflow_inspect", {
        kind: "file",
        text: JSON.stringify({
          ...source,
          tools: ["shell"],
          environment: { key: "inert-fixture" },
        }),
      });

      expect(hostile.status).not.toBe(200);
      expect(servers.map(threads)).toEqual(initialThreads);
    });
  });
});

const stateMachinesAvailable =
  Boolean(process.env.OMNYO_WORKFLOW_GRAPH_TEST_SOURCE) ||
  existsSync(
    join(resolveBuiltinPluginRootPath("state-machines"), "package.json"),
  );

describe.skipIf(!stateMachinesAvailable)("bundled workflow graph", () => {
  it("materializes the graph but refuses execution", async () => {
    await withCoordinators(async (sender, recipient) => {
      const servers = [sender, recipient];

      for (const name of ["state-machines", "provider-codex"]) {
        const plugin = await recipient.pluginService.install(
          `builtin:${name}`,
          { kind: "root" },
        );

        expect(plugin.status, plugin.statusDetail ?? undefined).toBe("running");
      }

      const initialThreads = servers.map(threads);
      const project = { projectId: PERSONAL_PROJECT_ID };

      const graphSource = {
        ...source,
        flow: {
          kind: "prompt",
          prompt: "Summarize only the startup notes supplied by the recipient.",
        },
      };

      const exported = await rpc(sender, "workflow_inspect", {
        kind: "file",
        text: JSON.stringify(graphSource),
      });

      const senderReview = reviewSchema
        .extend({ package: z.unknown() })
        .parse(exported);

      const review = reviewSchema.parse(
        await rpc(recipient, "workflow_inspect", {
          kind: "file",
          text: JSON.stringify(senderReview.package),
        }),
      );

      expect(review.packageDigest).toBe(senderReview.packageDigest);
      expect(review.capabilities).toEqual([
        "model-text",
        "write-run-artifacts",
      ]);

      const graphCopySchema = copySchema.extend({
        graphId: z.string().min(1),
        graphVersion: z.literal(1),
      });

      const request = {
        ...project,
        reviewId: review.reviewId,
        packageDigest: review.packageDigest,
        requestId: "recipient-graph",
      };

      const copy = graphCopySchema.parse(
        await rpc(recipient, "workflow_install", request),
      );

      expect(
        graphCopySchema.parse(
          await rpc(recipient, "workflow_install", request),
        ),
      ).toEqual(copy);
      const target = { ...project, importId: copy.importId };

      const bound = copySchema
        .extend({
          graphId: z.string(),
          graphVersion: z.literal(1),
          bindings: z.object({
            inputs: z.object({ startup: z.literal("Fictional Cedar Studio") }),
          }),
          bindingRevision: z.literal(1),
        })
        .parse(
          await rpc(recipient, "workflow_bind", {
            ...target,
            expectedRevision: 0,
            bindings: {
              hostId: "unconnected-fixture-host",
              providerId: "codex",
              model: "fixture-model",
              inputs: { startup: "Fictional Cedar Studio" },
            },
          }),
        );

      expect(await rpc(recipient, "workflow_preview", target)).toMatchObject({
        copy: { confirmation: null, automationId: null },
        example: expect.any(String),
      });
      await rpc(recipient, "workflow_confirm", {
        ...target,
        expectedRevision: bound.bindingRevision,
        executionDigest: bound.executionDigest,
      });

      for (const [method, input] of [
        ["workflow_run", { ...target, requestId: "refused-graph-run" }],
        ["workflow_enable", target],
      ] as const) {
        const refused = await response(recipient, method, input);
        expect(refused.status).toBe(500);
        expect(await refused.text()).toContain("Enable Account Pooler");
      }

      const direct = await fetch(
        `${recipient.baseUrl}/api/v1/plugins/state-machines/rpc/sm_workflow_preflight`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hostId: "unconnected-fixture-host",
            providerId: "codex",
            model: "fixture-model",
          }),
          signal: AbortSignal.timeout(5000),
        },
      );

      expect(direct.status).toBe(500);
      expect(await direct.text()).toContain(
        "Only the coordinator workflow owner",
      );
      expect(await rpc(recipient, "automations_list", project)).toEqual([]);
      expect(await rpc(sender, "workflow_list", project)).toEqual([]);
      expect(servers.map(threads)).toEqual(initialThreads);

      if (process.env.OMNYO_WORKFLOW_EVIDENCE === "1") {
        process.stdout.write(
          JSON.stringify({
            proofId: "WF-JOURNEY",
            surface: "local HTTP graph intake",
            sender: sender.baseUrl,
            recipient: recipient.baseUrl,
            projectId: copy.projectId,
            importId: copy.importId,
            packageDigest: copy.packageDigest,
            executionDigest: bound.executionDigest,
            graphId: copy.graphId,
            graphVersion: copy.graphVersion,
            bindingRevision: bound.bindingRevision,
            enablement: "refused before provider inference",
          }) + "\n",
        );
      }
    });
  });
});

describe("downloaded public workflow package through two coordinators", () => {
  it.skipIf(!process.env.OMNYO_WORKFLOW_TEST_FILE)(
    "imports the byte-exact downloaded revision without schedules or model calls",
    async () => {
      const file = z
        .string()
        .min(1)
        .parse(process.env.OMNYO_WORKFLOW_TEST_FILE);

      const expectedDigest = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(process.env.OMNYO_WORKFLOW_TEST_SHA256);

      const bytes = readFileSync(file);
      const text = bytes.toString("utf8");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        expectedDigest,
      );
      expect(JSON.parse(text)).toMatchObject({ revision: 2 });
      await withCoordinators(async (sender, recipient) => {
        const servers = [sender, recipient];
        await Promise.all(
          servers.map(async (server) => {
            const plugin = await server.pluginService.install(
              "builtin:state-machines",
              { kind: "root" },
            );

            expect(plugin.status, plugin.statusDetail ?? undefined).toBe(
              "running",
            );
          }),
        );
        const initialThreads = servers.map(threads);
        const project = { projectId: PERSONAL_PROJECT_ID };

        const reviews = await Promise.all(
          servers.map(async (server) =>
            reviewSchema.parse(
              await rpc(server, "workflow_inspect", { kind: "file", text }),
            ),
          ),
        );

        const [senderReview, recipientReview] = reviews;
        expect(senderReview).toBeDefined();
        expect(recipientReview).toBeDefined();

        if (!senderReview || !recipientReview)
          throw new Error("Two reviews are required");
        expect(senderReview.packageDigest).toBe(expectedDigest);
        expect(recipientReview.packageDigest).toBe(expectedDigest);
        expect(recipientReview.executionDigest).toBe(
          senderReview.executionDigest,
        );
        expect(recipientReview.reviewId).not.toBe(senderReview.reviewId);

        const graphCopySchema = copySchema.extend({
          graphId: z.string().min(1),
          graphVersion: z.literal(1),
        });

        const copies = await Promise.all(
          servers.map(async (server, index) => {
            const review = reviews[index];

            if (!review) throw new Error("Missing coordinator review");

            return graphCopySchema.parse(
              await rpc(server, "workflow_install", {
                ...project,
                reviewId: review.reviewId,
                packageDigest: expectedDigest,
                requestId: "downloaded-gallery-copy",
              }),
            );
          }),
        );

        const [senderCopy, recipientCopy] = copies;

        if (!senderCopy || !recipientCopy)
          throw new Error("Two copies are required");
        expect(recipientCopy.importId).not.toBe(senderCopy.importId);

        for (const [index, server] of servers.entries()) {
          const copy = copies[index];

          if (!copy) throw new Error("Missing coordinator copy");
          expect(copy.packageDigest).toBe(expectedDigest);
          expect(copy.automationId).toBeNull();
          expect(copy.bindings).toBeNull();
          expect(copy.confirmation).toBeNull();
          const target = { ...project, importId: copy.importId };

          const exported = exportSchema.parse(
            await rpc(server, "workflow_export", target),
          );

          expect(exported.packageDigest).toBe(expectedDigest);
          expect(Buffer.from(exported.text, "utf8")).toEqual(bytes);
          const output = process.env.OMNYO_WORKFLOW_TEST_RECIPIENT_EXPORT;

          if (server === recipient && output)
            writeFileSync(output, exported.text, { flag: "wx" });
          expect(await rpc(server, "workflow_preview", target)).toMatchObject({
            copy: { confirmation: null, automationId: null },
            example: expect.any(String),
          });
          expect(
            (await response(server, "workflow_enable", target)).status,
          ).not.toBe(200);
          expect(await rpc(server, "automations_list", project)).toEqual([]);
        }

        expect(servers.map(threads)).toEqual(initialThreads);

        if (process.env.OMNYO_WORKFLOW_EVIDENCE === "1")
          process.stdout.write(
            JSON.stringify({
              proofId: "WORKFLOW-GALLERY-JOURNEY",
              surface: "local HTTP downloaded package intake",
              packageDigest: expectedDigest,
              revision: 2,
              sender: sender.baseUrl,
              recipient: recipient.baseUrl,
              senderImportId: senderCopy.importId,
              recipientImportId: recipientCopy.importId,
              schedules: "disabled",
              inference: "none",
            }) + "\n",
          );
      });
    },
  );
});
