// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { attachmentDiagnosticSchema } from "@omnyo/server-contract";
import {
  carryAttachmentObservation,
  noteAttachmentNativePath,
  observePastedFiles,
  reportEmptyAttachment,
} from "./attachment-diagnostics";

vi.mock("./api-server", () => ({
  apiClient: {
    system: {
      "attachment-diagnostic": {
        $url: () =>
          new URL("https://omnyo.example/api/v1/system/attachment-diagnostic"),
      },
    },
  },
  toRelativeUrl: (url: URL) => url.pathname,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch() {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);

  return fetcher;
}

function sentReport(fetcher: ReturnType<typeof stubFetch>) {
  const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/v1/system/attachment-diagnostic");

  return attachmentDiagnosticSchema.parse(JSON.parse(String(init.body)));
}

it("reports paste facts for an empty pasted image without its name or contents", async () => {
  const fetcher = stubFetch();
  const pasted = new File([], "secret plan.png", { type: "image/png" });
  observePastedFiles([pasted], {
    clipboardTypes: ["Files", "image/png", "text/plain secret"],
    nativeResolver: true,
    replayed: true,
  });

  const renamed = new File([pasted], "secret plan-2.png", {
    type: "image/png",
  });

  carryAttachmentObservation(pasted, renamed);
  noteAttachmentNativePath(renamed, false);

  await reportEmptyAttachment(renamed, "empty_before_upload");

  const report = sentReport(fetcher);
  expect(report).toMatchObject({
    cause: "empty_before_upload",
    source: "paste",
    mimeType: "image/png",
    extension: "png",
    sizeAtUpload: 0,
    sizeAtPaste: 0,
    readableBytes: null,
    clipboardTypes: ["Files", "image/png"],
    pastedFileCount: 1,
    nativeResolver: true,
    nativePath: false,
    replayed: true,
  });
  expect(JSON.stringify(report)).not.toContain("secret");
});

it("checks whether the browser can still read a file the server received empty", async () => {
  const fetcher = stubFetch();
  const file = new File(["png-bytes"], "image.png", { type: "image/png" });

  await reportEmptyAttachment(file, "empty_on_server");

  expect(sentReport(fetcher)).toMatchObject({
    cause: "empty_on_server",
    source: "other",
    sizeAtUpload: 9,
    sizeAtPaste: null,
    readableBytes: 9,
    readError: null,
  });
});
