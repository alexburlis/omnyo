import { describe, expect, it } from "vitest";
import { updateProjectRequestSchema } from "../src/api/projects.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

describe("custom project icon requests", () => {
  it("accepts a small PNG override and an explicit reset", () => {
    expect(updateProjectRequestSchema.parse({ customIcon: PNG })).toEqual({
      customIcon: PNG,
    });
    expect(updateProjectRequestSchema.parse({ customIcon: null })).toEqual({
      customIcon: null,
    });
  });
  it("rejects a forged PNG header without image chunks", () => {
    const bytes = Buffer.alloc(45);
    bytes.write("\x89PNG\r\n\x1a\n", 0, "latin1");
    bytes.write("IHDR", 12);
    bytes.writeUInt32BE(1, 16);
    bytes.writeUInt32BE(1, 20);
    bytes.write("IEND", 37);
    expect(
      updateProjectRequestSchema.safeParse({
        customIcon: `data:image/png;base64,${bytes.toString("base64")}`,
      }).success,
    ).toBe(false);
  });
  it.each([
    "https://example.com/icon.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,aGVsbG8=",
    `data:image/png;base64,${"A".repeat(70000)}`,
  ])("rejects invalid or oversized icons", (customIcon) => {
    expect(updateProjectRequestSchema.safeParse({ customIcon }).success).toBe(
      false,
    );
  });
});
