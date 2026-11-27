import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { ProjectImagePreview } from "../components/project-image";
import type { ProjectImage } from "../contract";

const image: ProjectImage = {
  kind: "project-image",
  projectId: "project-other",
  path: "uploads/result.png",
  mimeType: "image/png",
  alt: "Updated narrow layout",
};

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function objectUrls() {
  const create = vi.fn(() => "blob:http://localhost/image-1");
  const revoke = vi.fn();

  class ImageURL extends URL {
    static createObjectURL = create;
    static revokeObjectURL = revoke;
  }

  vi.stubGlobal("URL", ImageURL);
  vi.stubGlobal("IntersectionObserver", undefined);

  return { create, revoke };
}

describe("project image delivery", () => {
  it("does not create a temporary image after its view closes during the read", async () => {
    const urls = objectUrls();
    let finish: (() => void) | undefined;

    const read = vi.fn(
      () =>
        new Promise<{ bytes: Uint8Array; sizeBytes: number; mimeType: string }>((resolve) => {
          finish = () => resolve({ bytes, sizeBytes: bytes.length, mimeType: "image/png" });
        }),
    );

    renderSlot(
      { component: () => <ProjectImagePreview image={image} title="Result" /> },
      {},
      { sdk: { projects: { attachments: { read } } } },
    );
    fireEvent.click(screen.getByRole("button", { name: "View image" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    cleanup();
    await act(async () => {
      finish?.();
    });
    expect(urls.create).not.toHaveBeenCalled();
  });
  it("loads only on demand from the explicit project and releases the image on unmount", async () => {
    const urls = objectUrls();

    const read = vi.fn(
      async (_input: { projectId: string; path: string; signal?: AbortSignal }) => ({
        bytes,
        sizeBytes: bytes.length,
        mimeType: "image/png",
      }),
    );

    const view = renderSlot(
      { component: () => <ProjectImagePreview image={image} title="Result" /> },
      {},
      {
        sdk: { projects: { attachments: { read } } },
      },
    );

    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View image" }));
    await screen.findByRole("img", { name: image.alt });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-other", path: "uploads/result.png" }),
    );
    expect(urls.create).toHaveBeenCalledTimes(1);
    const signal = read.mock.calls[0]?.[0]?.signal;
    cleanup();
    expect(signal?.aborted).toBe(true);
    expect(urls.revoke).toHaveBeenCalledWith("blob:http://localhost/image-1");
    expect(view.inspection.composer.submits).toEqual([]);
  });

  it("keeps errors visible and retries a rejected image without changing its owner", async () => {
    const urls = objectUrls();
    let calls = 0;

    const read = vi.fn(async () => {
      calls += 1;

      return calls === 1
        ? { bytes: new Uint8Array([60, 115, 118, 103]), sizeBytes: 4, mimeType: "image/png" }
        : { bytes, sizeBytes: bytes.length, mimeType: "image/png" };
    });

    renderSlot(
      { component: () => <ProjectImagePreview image={image} title="Result" /> },
      {},
      { sdk: { projects: { attachments: { read } } } },
    );
    fireEvent.click(screen.getByRole("button", { name: "View image" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "does not match its image format",
    );
    expect(urls.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry image" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await screen.findByRole("img", { name: image.alt });
  });
});
