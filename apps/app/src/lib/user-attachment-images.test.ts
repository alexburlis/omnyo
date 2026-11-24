import { describe, expect, it, vi } from "vitest";
import {
  toUserAttachmentImageSrc,
  userAttachmentThumbnailSources,
} from "./user-attachment-images";

vi.mock("./api-server", () => ({
  apiClient: {
    projects: {
      ":id": {
        attachments: {
          content: {
            $url: ({
              param,
              query,
            }: {
              param: { id: string };
              query: { path: string; thumbnailWidth?: string };
            }) => {
              const url = new URL(
                `http://localhost/api/v1/projects/${param.id}/attachments/content`,
              );

              url.searchParams.set("path", query.path);

              if (query.thumbnailWidth !== undefined)
                url.searchParams.set("thumbnailWidth", query.thumbnailWidth);

              return url;
            },
          },
        },
      },
    },
    threads: {
      ":id": {
        "host-files": {
          ":filePath{.+}": {
            $url: ({
              param,
              query,
            }: {
              param: { id: string; filePath: string };
              query?: { thumbnailWidth?: string };
            }) => {
              const url = new URL(
                `http://localhost/api/v1/threads/${param.id}/host-files/${param.filePath}`,
              );

              if (query?.thumbnailWidth !== undefined)
                url.searchParams.set("thumbnailWidth", query.thumbnailWidth);

              return url;
            },
          },
        },
      },
    },
  },
  toRelativeUrl: (url: URL) => `${url.pathname}${url.search}`,
}));

describe("sent attachment image sources", () => {
  it("keeps native URLs separate from responsive uploaded-thumbnail URLs", () => {
    const sources = userAttachmentThumbnailSources(
      "uploaded photo.png",
      "project-1",
    );

    expect(sources?.src).toBe(
      "/api/v1/projects/project-1/attachments/content?path=uploaded+photo.png&thumbnailWidth=160",
    );
    expect(sources?.srcSet).toContain("thumbnailWidth=320 2x");
    expect(sources?.srcSet).toContain("thumbnailWidth=640 4x");
    expect(
      toUserAttachmentImageSrc("uploaded photo.png", "project-1"),
    ).not.toContain("thumbnailWidth");
    expect(
      userAttachmentThumbnailSources(
        "https://example.com/image.png",
        "project-1",
      ),
    ).toBeNull();
    expect(
      userAttachmentThumbnailSources("/absolute.png", "project-1"),
    ).toBeNull();
  });

  it("builds responsive host-file thumbnails for absolute paths in a thread", () => {
    const host =
      "/api/v1/threads/thread-1/host-files/Users/developer/Desktop/shot%201.png";

    expect(
      userAttachmentThumbnailSources(
        "/Users/developer/Desktop/shot 1.png",
        "project-1",
        "thread-1",
      ),
    ).toEqual({
      src: `${host}?thumbnailWidth=160`,
      srcSet: `${host}?thumbnailWidth=160 1x, ${host}?thumbnailWidth=320 2x, ${host}?thumbnailWidth=640 4x`,
    });
    expect(
      toUserAttachmentImageSrc(
        "/Users/developer/Desktop/shot 1.png",
        "project-1",
        "thread-1",
      ),
    ).toBe(host);
    expect(
      userAttachmentThumbnailSources(
        "uploaded photo.png",
        "project-1",
        "thread-1",
      )?.src,
    ).toBe(
      "/api/v1/projects/project-1/attachments/content?path=uploaded+photo.png&thumbnailWidth=160",
    );
  });

  it.each([
    [
      "/Users/developer/Downloads/Screenshot-1105-084651.png",
      "/api/v1/threads/thread-1/host-files/Users/developer/Downloads/Screenshot-1105-084651.png",
    ],
    [
      "/Users/developer/Downloads/Screenshot 2026-11-05 #1?.png",
      "/api/v1/threads/thread-1/host-files/Users/developer/Downloads/Screenshot%202026-11-05%20%231%3F.png",
    ],
    [
      "C:\\Users\\Developer\\Pictures\\shot.png",
      "/api/v1/threads/thread-1/host-files/C%3A/Users/developer/Pictures/shot.png",
    ],
    [
      "/Users/developer/Pictures/100% done.png",
      "/api/v1/threads/thread-1/host-files/Users/developer/Pictures/100%25%20done.png",
    ],
  ])("routes %s through its thread's authenticated host", (path, expected) => {
    expect(toUserAttachmentImageSrc(path, "project-1", "thread-1")).toBe(
      expected,
    );
  });

  it("keeps uploaded attachments in project storage", () => {
    expect(
      toUserAttachmentImageSrc("uploaded-photo.png", "project-1", "thread-1"),
    ).toBe(
      "/api/v1/projects/project-1/attachments/content?path=uploaded-photo.png",
    );
  });

  it.each([
    "https://example.com/photo.png",
    "data:image/png;base64,YQ==",
    "blob:https://omnyo.example/image-1",
  ])("preserves %s", (src) => {
    expect(toUserAttachmentImageSrc(src, "project-1", "thread-1")).toBe(src);
  });

  it("does not change the composer resolver without thread context", () => {
    expect(toUserAttachmentImageSrc("uploaded-photo.png", "project-1")).toBe(
      "/api/v1/projects/project-1/attachments/content?path=uploaded-photo.png",
    );
  });
});
