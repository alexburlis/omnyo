import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as fixtures from "../helpers/command-output-fixtures.js";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("omnyo thread tell command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it.each([false, true])(
    "omnyo thread tell sends an explicit send-now override only when requested (%s)",
    async (sendNow) => {
      const post = vi.fn(async (_request: { json: unknown }) => ({
        ok: true,
        delivery: "sent",
      }));

      stubServerApi({ "v1.threads.:id.send.$post": post });
      await runCommand(
        [
          "thread",
          "tell",
          "thread-force",
          "hello",
          ...(sendNow ? ["--send-now"] : []),
        ],
        register,
      );
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          json: expect.objectContaining({
            input: [expect.objectContaining({ text: "hello" })],
            ...(sendNow ? { sendNow: true } : {}),
          }),
        }),
      );

      if (!sendNow)
        expect(post.mock.calls[0]?.[0]).toHaveProperty(
          "json.sendNow",
          undefined,
        );
    },
  );

  it.each([undefined, "Release runner"])(
    "records the CLI or named script source %s",
    async (source) => {
      const post = vi.fn(async () => ({ ok: true, delivery: "sent" }));
      stubServerApi({ "v1.threads.:id.send.$post": post });
      await runCommand(
        [
          "thread",
          "tell",
          "thread-source",
          "Result ready",
          ...(source === undefined ? [] : ["--source", source]),
        ],
        register,
      );
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          json: expect.objectContaining({
            messageSource: { kind: "script", label: source ?? "CLI" },
          }),
        }),
      );
    },
  );

  it("omnyo thread tell --json prints the raw response plus thread id", async () => {
    const post = vi.fn(async () => ({ ok: true, delivery: "sent" }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-json-tell", "hello", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      threadId: "thread-json-tell",
      ok: true,
      delivery: "sent",
      mode: "steer",
    });
  });

  it("omnyo thread tell --message-file sends shell-active text untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omnyo-tell-file-"));
    const path = join(dir, "message.md");

    const message =
      "Rebase with `git rebase --onto main` then run $(pnpm test)";

    await writeFile(path, `${message}\n`);

    const post = vi.fn(async (_request: { json: unknown }) => ({
      ok: true,
      delivery: "sent",
    }));

    stubServerApi({ "v1.threads.:id.send.$post": post });

    try {
      await runCommand(
        ["thread", "tell", "thread-file", "--message-file", path],
        register,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({
          input: [expect.objectContaining({ type: "text", text: message })],
        }),
      }),
    );
  });

  it("omnyo thread message is an alias for tell", async () => {
    const post = vi.fn(async () => ({ ok: true, delivery: "sent" }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "message", "thread-alias", "hello"], register);

    expect(post).toHaveBeenCalledTimes(1);
  });

  it("omnyo thread tell without any message says both ways to pass one", async () => {
    const post = vi.fn(async () => ({ ok: true, delivery: "sent" }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await expect(
      runCommand(["thread", "tell", "thread-empty"], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.error).mock.calls.map((call) => call[0])).toEqual([
      "Error: Missing <message>.",
      "Pass <message>, or --message-file <path> (use - to read stdin).",
    ]);
    expect(post).not.toHaveBeenCalled();
  });

  it("omnyo thread tell names the typed reason a message queued for", async () => {
    const post = vi.fn(async () => ({
      ok: true,
      delivery: "queued",
      queuedMessage: {
        id: "qm_1",
        waitingOn: { kind: "interaction" },
        sendAt: null,
      },
    }));

    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-blocked", "hello"], register);

    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
      "Thread thread-blocked message queued (waiting for a pending interaction); it dispatches when that clears",
    );
  });

  it.each([
    [false, "Thread thread-waiter stored the result for its wait"],
    [
      true,
      "Thread thread-waiter stored a late result; its wait had already ended",
    ],
  ])(
    "omnyo thread tell says a wait result was stored, not sent (late: %s)",
    async (late, expected) => {
      stubServerApi({
        "v1.threads.:id.send.$post": async () => ({
          ok: true,
          delivery: "stored",
          late,
        }),
      });

      await runCommand(
        [
          "thread",
          "tell",
          "thread-waiter",
          "[omnyo wait 11111111-2222-3333-4444-555555555555] Approved",
          "--mode",
          "auto",
        ],
        register,
      );

      expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(expected);
    },
  );

  it.each([
    ["destroyed", true, "omnyo thread restore-environment thread-gone"],
    ["destroyed", false, "Start a new thread"],
    ["never_attached", true, null],
  ] as const)(
    "omnyo thread tell explains a %s environment (restorable: %s)",
    async (reason, canRestoreEnvironment, hint) => {
      stubServerApi({
        "v1.threads.:id.$get": async () => ({
          ...fixtures.makeThread({
            id: "thread-gone",
            projectId: "proj-1",
            providerId: "codex",
          }),
          canRestoreEnvironment,
        }),
        "v1.threads.:id.send.$post": async () =>
          new Response(
            JSON.stringify({
              code: "thread_environment_unavailable",
              message: "Thread environment is unavailable",
              details: { reason, environmentStatus: null },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
      });

      await expect(
        runCommand(["thread", "tell", "thread-gone", "hello"], register),
      ).rejects.toThrow("process.exit:1");

      const errors = vi
        .mocked(console.error)
        .mock.calls.map((call) => String(call[0]));

      if (hint === null) {
        expect(errors).toEqual([
          "Error: HTTP 409: Thread environment is unavailable",
        ]);
      } else {
        expect(errors.some((line) => line.includes(hint))).toBe(true);
      }
    },
  );

  it("omnyo thread tell names the plugin a message is waiting on", async () => {
    const post = vi.fn(async () => ({
      ok: true,
      delivery: "queued",
      queuedMessage: {
        id: "qm_2",
        waitingOn: {
          kind: "plugin",
          pluginId: "concurrency-limit",
          reason: "4 of 4 running",
        },
        sendAt: null,
      },
    }));

    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-limited", "hello"], register);

    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
      "Thread thread-limited message queued (concurrency-limit: 4 of 4 running); it dispatches when that clears",
    );
  });

  it("omnyo thread tell keeps the steered wording for servers that only report ok", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-legacy", "hello"], register);

    expect(vi.mocked(console.log).mock.calls[0]?.[0]).toBe(
      "Thread thread-legacy steered",
    );
  });

  it("omnyo thread tell --mode queue preserves non-urgent queued delivery", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-queue-tell", "hello", "--mode", "queue"],
      register,
    );

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thread-queue-tell" },
        json: expect.objectContaining({
          input: [{ type: "text", text: "hello", mentions: [] }],
          mode: "queue-if-active",
        }),
      }),
    );
  });

  it("omnyo thread tell --mode auto preserves explicit legacy auto delivery", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-auto-tell", "hello", "--mode", "auto"],
      register,
    );

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thread-auto-tell" },
        json: expect.objectContaining({
          input: [{ type: "text", text: "hello", mentions: [] }],
          mode: "auto",
        }),
      }),
    );
  });

  it("omnyo thread tell forwards execution options", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-execution-options",
        "hello",
        "--model",
        "gpt-5.5",
        "--service-tier",
        "fast",
        "--reasoning-level",
        "high",
        "--permission-mode",
        "accept-edits",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thread-execution-options" },
        json: expect.objectContaining({
          input: [{ type: "text", text: "hello", mentions: [] }],
          mode: "steer-if-active",
          model: "gpt-5.5",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
        }),
      }),
    );
  });

  it("omnyo thread tell --plan sends the composer's /plan command mention", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-plan",
        "add a README",
        "--plan",
        "--file",
        "existing-report.pdf",
      ],
      register,
    );

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thread-plan" },
        json: expect.objectContaining({
          input: [
            {
              type: "text",
              text: "/plan add a README",
              mentions: [
                {
                  start: 0,
                  end: 5,
                  resource: {
                    kind: "command",
                    trigger: "/",
                    name: "plan",
                    source: "command",
                    origin: "builtin",
                    label: "plan",
                    argumentHint: null,
                  },
                },
              ],
            },
            { type: "localFile", path: "existing-report.pdf" },
          ],
          mode: "steer-if-active",
        }),
      }),
    );
  });

  it.each([
    ["image", "localImage", "screenshot.png", "image/png", false],
    ["file", "localFile", "report.pdf", "application/pdf", false],
    ["file", "localFile", "report with spaces.pdf", "application/pdf", true],
  ] as const)(
    "omnyo thread tell uploads client %s paths to the target project",
    async (flag, type, filename, mimeType, fileUrl) => {
      const clientDir = await mkdtemp(
        join(tmpdir(), "omnyo-cli-thread-image-"),
      );

      try {
        const attachmentPath = join(clientDir, filename);
        const uploadedPath = "uploaded-" + filename;
        const bytes = new Uint8Array([137, 80, 78, 71]);
        await writeFile(attachmentPath, bytes);

        const get = vi.fn(async () =>
          fixtures.makeThread({
            id: "thread-attachments",
            projectId: "proj-target",
            providerId: "codex",
          }),
        );

        const post = vi.fn(async () => ({ ok: true }));
        stubServerApi({
          "v1.threads.:id.$get": get,
          "v1.threads.:id.send.$post": post,
        });
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(
            JSON.stringify({
              type,
              path: uploadedPath,
              name: filename,
              mimeType,
              sizeBytes: bytes.byteLength,
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );

        await runCommand(
          [
            "thread",
            "tell",
            "thread-attachments",
            "review these",
            "--file",
            "existing-report.pdf",
            "--" + flag,
            fileUrl ? pathToFileURL(attachmentPath).href : attachmentPath,
          ],
          register,
        );

        expect(get).toHaveBeenCalledWith(
          expect.objectContaining({
            param: { id: "thread-attachments" },
          }),
        );
        expect(globalThis.fetch).toHaveBeenCalledWith(
          "http://server/api/v1/projects/proj-target/attachments",
          expect.objectContaining({
            body: expect.any(FormData),
            method: "POST",
          }),
        );
        const uploadBody = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body;
        expect(uploadBody).toBeInstanceOf(FormData);

        if (!(uploadBody instanceof FormData))
          throw new Error("Missing upload body");
        const uploadedFile = uploadBody.get("file");
        expect(uploadedFile).toBeInstanceOf(File);

        if (!(uploadedFile instanceof File))
          throw new Error("Missing uploaded file");
        expect(uploadedFile.name).toBe(filename);
        expect(uploadedFile.type).toBe(mimeType);
        expect(new Uint8Array(await uploadedFile.arrayBuffer())).toEqual(bytes);
        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({
            param: { id: "thread-attachments" },
            json: expect.objectContaining({
              input: [
                { type: "text", text: "review these", mentions: [] },
                { type: "localFile", path: "existing-report.pdf" },
                { type, path: uploadedPath },
              ],
              mode: "steer-if-active",
            }),
          }),
        );
      } finally {
        await rm(clientDir, { force: true, recursive: true });
      }
    },
  );

  it("omnyo thread tell includes sender thread metadata when run inside another thread", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-sender");
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(
      ["thread", "tell", "thread-receiver", "hello from sender"],
      register,
    );

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thread-receiver" },
        json: expect.objectContaining({
          input: [{ type: "text", text: "hello from sender", mentions: [] }],
          mode: "steer-if-active",
          senderThreadId: "thread-sender",
        }),
      }),
    );
  });

  it("omnyo thread tell omits sender metadata when targeting the current thread", async () => {
    vi.stubEnv("OMNYO_THREAD_ID", "thread-self");
    const post = vi.fn(async () => ({ ok: true }));
    stubServerApi({ "v1.threads.:id.send.$post": post });

    await runCommand(["thread", "tell", "thread-self", "self note"], register);

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        param: { id: "thread-self" },
        json: expect.objectContaining({
          input: [{ type: "text", text: "self note", mentions: [] }],
          mode: "steer-if-active",
        }),
      }),
    );
  });

  it("sends a retry-safe submission through the receipt route and never through the send route", async () => {
    const receipt = {
      version: 1,
      submissionId: "sub_0123456789abcdef0123456789abcdef",
      storeId: "store-cli",
      action: "thread-message",
      threadId: "thread-submission",
      queuedMessageId: "qtm_1",
      acceptedAt: 1,
      replayed: false,
    };

    const send = vi.fn(async () => ({ ok: true, delivery: "sent" }));
    const submit = vi.fn(async (_request: { json: unknown }) => receipt);

    stubServerApi({
      "v1.submissions.$post": submit,
      "v1.submissions.contract.$get": async () => ({
        version: 1,
        storeId: "store-cli",
      }),
      "v1.threads.:id.send.$post": send,
    });

    await runCommand(
      [
        "thread",
        "tell",
        "thread-submission",
        "retry me safely",
        "--mode",
        "queue",
        "--submission-id",
        receipt.submissionId,
        "--json",
      ],
      register,
    );

    expect(send).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith({
      json: {
        version: 1,
        submissionId: receipt.submissionId,
        storeId: "store-cli",
        action: {
          kind: "thread-message",
          threadId: "thread-submission",
          message: {
            input: [{ type: "text", text: "retry me safely", mentions: [] }],
            messageSource: { kind: "script", label: "CLI" },
          },
        },
        attachments: [],
      },
    });
    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(receipt);
  });

  it("refuses a submission ID outside queue mode before contacting the server", async () => {
    const submit = vi.fn(async () => ({}));
    const send = vi.fn(async () => ({ ok: true, delivery: "sent" }));

    stubServerApi({
      "v1.submissions.$post": submit,
      "v1.threads.:id.send.$post": send,
    });

    await expect(
      runCommand(
        [
          "thread",
          "tell",
          "thread-submission",
          "hello",
          "--submission-id",
          "sub_0123456789abcdef0123456789abcdef",
        ],
        register,
      ),
    ).rejects.toThrow("process.exit:1");

    expect(submit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
