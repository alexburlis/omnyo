import { beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "nice-grpc-common";
import { NotFoundError } from "modal";
import {
  createModalSandboxClient,
  createModalSandboxExecutor,
} from "./client.js";

const vendor = vi.hoisted(() => ({
  exec: vi.fn(),
  poll: vi.fn(),
  list: vi.fn(),
  tagged: vi.fn(),
  tags: vi.fn(),
  create: vi.fn(),
  app: vi.fn(),
  image: vi.fn(),
}));

vi.mock("modal", () => ({
  NotFoundError: class extends Error {},
  ModalClient: class {
    apps = { fromName: vendor.app };
    images = { fromId: vendor.image };
    cpClient = { sandboxList: vendor.list };
    environmentName() {
      return "main";
    }
    sandboxes = {
      list: vendor.tagged,
      create: vendor.create,
      fromId: async () => ({
        sandboxId: "sandbox-1",
        exec: vendor.exec,
        poll: vendor.poll,
        getTags: vendor.tags,
      }),
    };
  },
}));

async function executor() {
  const sandbox = await createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  }).fromId("sandbox-1");

  if (sandbox === null) throw new Error("missing sandbox");

  return createModalSandboxExecutor(sandbox);
}

function processResult() {
  const output = (value: string) => {
    const readText = vi.fn(async () => value);

    return {
      readText,
      async *[Symbol.asyncIterator]() {
        yield await readText();
      },
    };
  };

  return {
    stdin: {
      writeText: vi.fn(async (_value: string) => {}),
      close: vi.fn(async () => {}),
    },
    stdout: output("output"),
    stderr: output("error"),
    wait: vi.fn(async () => 7),
  };
}

beforeEach(() => {
  vendor.exec.mockReset();
  vendor.tagged.mockReset().mockImplementation(async function* () {});
  vendor.list.mockReset().mockResolvedValue({ sandboxes: [] });
  vendor.tags.mockReset().mockResolvedValue({ omnyoMachineKey: "owned-key" });
  vendor.create.mockReset().mockResolvedValue({ sandboxId: "new-sandbox" });
  vendor.app.mockReset().mockResolvedValue({ appId: "app-owned" });
  vendor.image.mockReset().mockResolvedValue({ imageId: "image" });
  vendor.poll.mockReset().mockResolvedValue(null);
});

describe("Modal bootstrap executor", () => {
  it("treats terminated allocations as absent so a checkpoint can restore its snapshot", async () => {
    vendor.poll.mockResolvedValue(0);
    await expect(
      createModalSandboxClient({ tokenId: "id", tokenSecret: "secret" }).fromId(
        "sandbox-1",
      ),
    ).resolves.toBeNull();
  });

  it("treats a missing sandbox reported by SandboxWait as absent but preserves other RPC failures", async () => {
    const client = createModalSandboxClient({
      tokenId: "id",
      tokenSecret: "secret",
    });

    vendor.poll.mockRejectedValueOnce(
      Object.assign(new Error("SandboxWait NOT_FOUND"), {
        name: "ClientError",
        code: Status.NOT_FOUND,
      }),
    );
    await expect(client.fromId("sandbox-1")).resolves.toBeNull();

    const unavailable = Object.assign(new Error("unavailable"), {
      name: "ClientError",
      code: Status.UNAVAILABLE,
    });

    vendor.poll.mockRejectedValueOnce(unavailable);
    await expect(client.fromId("sandbox-1")).rejects.toBe(unavailable);
  });

  it("delivers stdin without putting credentials into command arguments and closes input", async () => {
    const process = processResult();
    vendor.exec.mockResolvedValue(process);
    const transport = await executor();
    await expect(
      transport.exec({
        onOutput: vi.fn(),
        command: ["omnyo", "machine", "enroll"],
        timeoutMs: 1234,
        signal: new AbortController().signal,
        stdin: "credential-secret",
      }),
    ).resolves.toEqual({ exitCode: 7 });
    expect(vendor.exec).toHaveBeenCalledWith(["omnyo", "machine", "enroll"], {
      mode: "text",
      stdout: "pipe",
      stderr: "pipe",
      timeoutMs: 1000,
    });
    expect(process.stdin.writeText).toHaveBeenCalledWith("credential-secret");
    expect(process.stdin.close).toHaveBeenCalledOnce();
  });

  it("streams stdout and stderr without returning duplicate captured output", async () => {
    const process = processResult();
    vendor.exec.mockResolvedValue(process);
    const transport = await executor();
    const onOutput = vi.fn();
    await expect(
      transport.exec({
        stdin: "",
        command: ["installer"],
        timeoutMs: 1000,
        signal: new AbortController().signal,
        onOutput,
      }),
    ).resolves.toEqual({ exitCode: 7 });
    expect(onOutput).toHaveBeenCalledWith("output");
    expect(onOutput).toHaveBeenCalledWith("error");
  });

  it("closes stdin for empty input and when input delivery fails", async () => {
    const process = processResult();
    vendor.exec.mockResolvedValue(process);
    const transport = await executor();

    const request = {
      onOutput: vi.fn(),
      stdin: "",
      command: ["true"],
      timeoutMs: 1000,
      signal: new AbortController().signal,
    };

    await transport.exec(request);
    expect(process.stdin.writeText).toHaveBeenCalledWith("");
    expect(process.stdin.close).toHaveBeenCalledOnce();
    process.stdin.writeText.mockRejectedValueOnce(new Error("write failed"));
    await expect(
      transport.exec({ ...request, stdin: "secret" }),
    ).rejects.toThrow("write failed");
    expect(process.stdin.close).toHaveBeenCalledTimes(2);
  });

  it("does not submit cancelled commands and stops waiting for in-flight commands", async () => {
    const controller = new AbortController();
    const transport = await executor();

    const request = {
      onOutput: vi.fn(),
      stdin: "",
      command: ["sleep", "60"],
      timeoutMs: 1000,
      signal: controller.signal,
    };

    const process = processResult();
    let finish: (value: string) => void = () => {};

    process.stdout.readText.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    vendor.exec.mockResolvedValue(process);
    const pending = transport.exec(request);
    await vi.waitFor(() =>
      expect(process.stdout.readText).toHaveBeenCalledOnce(),
    );
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    await expect(transport.exec(request)).rejects.toThrow("cancelled");
    expect(vendor.exec).toHaveBeenCalledOnce();
    finish("finished");
  });
});

it("uses the vendor start and timeout for expiry and scopes inventory to the owned key", async () => {
  vendor.list.mockImplementation(async ({ tags, beforeTimestamp }) => ({
    sandboxes:
      beforeTimestamp === undefined && tags[0].tagName === "omnyoMachineKey"
        ? [
            {
              id: "sandbox-1",
              appId: "app-owned",
              name: "owned-key",
              tags: [{ tagName: "omnyoMachineKey", tagValue: "owned-key" }],
              createdAt: 100.123456,
              timeoutSecs: 60,
            },
          ]
        : [],
  }));

  const backend = createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  });

  expect(
    await backend.observe({
      sandboxId: "sandbox-1",
      appName: "app",
      key: "owned-key",
    }),
  ).toEqual({ running: true, expiresAt: 160_123 });
  expect(vendor.list).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: "app-owned",
      includeFinished: false,
      tags: [{ tagName: "omnyoMachineKey", tagValue: "owned-key" }],
    }),
  );
  expect(
    await backend.observe({
      sandboxId: "missing",
      appName: "app",
      key: "owned-key",
    }),
  ).toEqual({ running: false, expiresAt: null });
});

it("bounds debug output while draining streams and preserving command failure", async () => {
  const process = processResult();

  const stream = () =>
    new ReadableStream<string>({
      start(controller) {
        controller.enqueue("abcdef");
        controller.enqueue("more");
        controller.close();
      },
    });

  vendor.exec.mockResolvedValue({
    ...process,
    stdout: stream(),
    stderr: stream(),
  });

  const sandbox = await createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  }).fromId("sandbox-1");

  expect(
    await sandbox?.exec(["noisy"], {
      timeoutMs: 60_000,
      maxOutputBytes: 4,
      signal: new AbortController().signal,
    }),
  ).toEqual({
    exitCode: 7,
    stdout: "abcd\n[output truncated]",
    stderr: "abcd\n[output truncated]",
  });
});

it("lists every tagged sandbox across apps and propagates enumeration failures", async () => {
  const client = createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  });

  const terminate = vi.fn(async () => {});
  vendor.tagged.mockImplementation(async function* () {
    yield { sandboxId: "first-app-sandbox", terminate, getTags: vendor.tags };
    yield { sandboxId: "second-app-sandbox", terminate, getTags: vendor.tags };
    throw new Error("next page failed");
  });
  const ids: string[] = [];
  await expect(
    (async () => {
      for await (const sandbox of client.listByKey("owned-key")) {
        ids.push(sandbox.sandboxId);
        await sandbox.terminate();
      }
    })(),
  ).rejects.toThrow("next page failed");
  expect(ids).toEqual([]);
  expect(terminate).not.toHaveBeenCalled();
  expect(vendor.tagged).toHaveBeenCalledWith({
    tags: { omnyoMachineKey: "owned-key" },
  });
});

it("validates every tagged sandbox before yielding any cleanup handle", async () => {
  const terminate = vi.fn(async () => {});
  vendor.tagged.mockImplementation(async function* () {
    yield {
      sandboxId: "owned",
      terminate,
      getTags: async () => ({ omnyoMachineKey: "owned-key" }),
    };
    yield {
      sandboxId: "foreign",
      terminate,
      getTags: async () => ({ omnyoMachineKey: "other-key" }),
    };
  });

  const client = createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  });

  const ids: string[] = [];
  await expect(
    (async () => {
      for await (const sandbox of client.listByKey("owned-key")) {
        ids.push(sandbox.sandboxId);
        await sandbox.terminate();
      }
    })(),
  ).rejects.toThrow("Foreign Modal sandbox ownership");
  expect(ids).toEqual([]);
  expect(terminate).not.toHaveBeenCalled();
});

it("refuses duplicate owners of one managed name instead of choosing a winner", async () => {
  vendor.list.mockImplementation(async ({ tags, beforeTimestamp }) => ({
    sandboxes:
      beforeTimestamp === undefined
        ? ["first", "second"].map((id, index) => ({
            id,
            appId: "app-owned",
            name: "owned-key",
            tags,
            createdAt: 2 - index,
            timeoutSecs: 60,
          }))
        : [],
  }));

  const client = createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  });

  await expect(client.fromName("app", "owned-key")).rejects.toThrow(
    "Multiple Modal",
  );
  expect(vendor.create).not.toHaveBeenCalled();
});

const ownedRequest = {
  appName: "app",
  name: "owned-key",
  image: { type: "image" as const, imageId: "image" },
  timeoutMs: 60_000,
  cpu: null,
  memoryMiB: null,
};

const freshModalOwnershipCases: Record<string, string>[] = [
  { omnyoMachineKey: "owned-key", untouched: "omnyo-user-value" },
];

it.each(freshModalOwnershipCases)(
  "emits canonical fresh Modal tags and retains original caller bytes",
  async (tags) => {
    const raw = JSON.stringify(tags);

    const client = createModalSandboxClient({
      tokenId: "id",
      tokenSecret: "secret",
    });

    await client.create({ ...ownedRequest, tags });
    expect(vendor.create.mock.calls[0]?.[2].tags).toEqual({
      omnyoMachineKey: "owned-key",
      untouched: "omnyo-user-value",
    });
    expect(JSON.stringify(tags)).toBe(raw);
  },
);

const invalidModalOwnershipCases: Record<string, string>[] = [
  { omnyoMachineKey: "" },
  { omnyoMachineKey: "foreign" },
  { omnyoMachineKey: "foreign", omnyoDebug: "true" },
  { omnyoMachineKey: "owned-key", omnyoDebug: "invalid" },
];

it.each(invalidModalOwnershipCases)(
  "refuses invalid Modal create ownership before any provider effect",
  async (tags) => {
    const client = createModalSandboxClient({
      tokenId: "id",
      tokenSecret: "secret",
    });

    await expect(client.create({ ...ownedRequest, tags })).rejects.toThrow();
    expect(vendor.app).not.toHaveBeenCalled();
    expect(vendor.image).not.toHaveBeenCalled();
    expect(vendor.create).not.toHaveBeenCalled();
  },
);

it.each(["omnyoMachineKey"] as const)(
  "recovers one exact %s named owner and preserves its tags",
  async (tagName) => {
    const raw = { [tagName]: "owned-key" };
    vendor.tags.mockResolvedValue(raw);
    vendor.list.mockImplementation(async ({ tags, beforeTimestamp }) => ({
      sandboxes:
        beforeTimestamp === undefined && tags[0].tagName === tagName
          ? [
              {
                id: "sandbox-1",
                appId: "app-owned",
                name: "owned-key",
                tags: [{ tagName, tagValue: "owned-key" }],
                createdAt: 1,
                timeoutSecs: 60,
              },
            ]
          : [],
    }));

    const client = createModalSandboxClient({
      tokenId: "id",
      tokenSecret: "secret",
    });

    expect((await client.fromName("app", "owned-key"))?.sandboxId).toBe(
      "sandbox-1",
    );
    expect(
      await client.observe({
        sandboxId: "sandbox-1",
        appName: "app",
        key: "owned-key",
      }),
    ).toEqual({ running: true, expiresAt: 61_000 });
    expect(raw).toEqual({ [tagName]: "owned-key" });
    expect(vendor.create).not.toHaveBeenCalled();
  },
);

it.each([
  {
    id: "sandbox-1",
    appId: "foreign",
    name: "owned-key",
    tags: [{ tagName: "omnyoMachineKey", tagValue: "owned-key" }],
  },
  {
    id: "sandbox-1",
    appId: "app-owned",
    name: "foreign",
    tags: [{ tagName: "omnyoMachineKey", tagValue: "owned-key" }],
  },
  {
    id: "sandbox-1",
    appId: "app-owned",
    name: "owned-key",
    tags: [
      { tagName: "omnyoMachineKey", tagValue: "owned-key" },
      { tagName: "omnyoMachineKey", tagValue: "owned-key" },
    ],
  },
])(
  "refuses foreign, dual and malformed named Modal ownership without adopting a handle",
  async (sandbox) => {
    vendor.list
      .mockResolvedValueOnce({ sandboxes: [sandbox] })
      .mockResolvedValueOnce({ sandboxes: [] });

    const client = createModalSandboxClient({
      tokenId: "id",
      tokenSecret: "secret",
    });

    await expect(client.fromName("app", "owned-key")).rejects.toThrow();
    expect(vendor.poll).not.toHaveBeenCalled();
    expect(vendor.create).not.toHaveBeenCalled();
  },
);

it("checks a pinned resource key before allowing a live by-id handle", async () => {
  vendor.tags.mockResolvedValue({ omnyoMachineKey: "foreign" });

  const client = createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  });

  await expect(
    Reflect.apply(client.fromId, client, ["sandbox-1", "owned-key"]),
  ).rejects.toThrow("Foreign");
  expect(vendor.exec).not.toHaveBeenCalled();
});

it.each([["omnyoMachineKey", "omnyoDebug"]] as const)(
  "recovers original and current %s debug ownership through the explicit debug caller mode",
  async (machineTag, debugTag) => {
    const tags = { [machineTag]: "owned-key", [debugTag]: "true" };
    const raw = JSON.stringify(tags);
    vendor.tags.mockResolvedValue(tags);
    vendor.list.mockImplementation(
      async ({ tags: query, beforeTimestamp }) => ({
        sandboxes:
          beforeTimestamp === undefined && query[0].tagName === machineTag
            ? [
                {
                  id: "sandbox-1",
                  appId: "app-owned",
                  name: "owned-key",
                  tags: Object.entries(tags).map(([tagName, tagValue]) => ({
                    tagName,
                    tagValue,
                  })),
                  createdAt: 1,
                  timeoutSecs: 60,
                },
              ]
            : [],
      }),
    );

    const client = createModalSandboxClient({
      tokenId: "id",
      tokenSecret: "secret",
    });

    const request = {
      sandboxId: "sandbox-1",
      appName: "app",
      key: "owned-key",
      debug: true,
    };

    expect(await client.observe(request)).toEqual({
      running: true,
      expiresAt: 61_000,
    });
    expect(
      (
        await Reflect.apply(client.fromId, client, [
          "sandbox-1",
          "owned-key",
          true,
        ])
      )?.sandboxId,
    ).toBe("sandbox-1");
    await expect(
      client.observe({
        sandboxId: "sandbox-1",
        appName: "app",
        key: "owned-key",
      }),
    ).rejects.toThrow("Foreign");
    await client.create({ ...ownedRequest, tags });
    expect(vendor.create.mock.calls[0]?.[2].tags).toEqual({
      omnyoMachineKey: "owned-key",
      omnyoDebug: "true",
    });
    expect(JSON.stringify(tags)).toBe(raw);
  },
);

it("refuses foreign preflight ownership before adopting a handle or preparing an image", async () => {
  vendor.list.mockResolvedValueOnce({
    sandboxes: [
      {
        id: "sandbox-1",
        appId: "foreign",
        name: "owned-key",
        tags: [{ tagName: "omnyoMachineKey", tagValue: "owned-key" }],
        createdAt: 1,
      },
    ],
  });

  const client = createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  });

  const preflight = Reflect.get(client, "validateOwnership");
  expect(preflight).toBeTypeOf("function");
  await expect(
    Reflect.apply(preflight, client, ["app", "owned-key"]),
  ).rejects.toThrow();
  expect(vendor.poll).not.toHaveBeenCalled();
  expect(vendor.image).not.toHaveBeenCalled();
  expect(vendor.create).not.toHaveBeenCalled();
});

it("keeps an exactly missing Modal app eligible for fresh creation after ownership preflight", async () => {
  vendor.app.mockRejectedValueOnce(new NotFoundError("missing app"));

  const client = createModalSandboxClient({
    tokenId: "id",
    tokenSecret: "secret",
  });

  const preflight = Reflect.get(client, "validateOwnership");
  expect(preflight).toBeTypeOf("function");
  await expect(
    Reflect.apply(preflight, client, ["app", "owned-key"]),
  ).resolves.toBeUndefined();
  await client.create({
    ...ownedRequest,
    tags: { omnyoMachineKey: "owned-key" },
  });
  expect(vendor.create).toHaveBeenCalledOnce();
});
