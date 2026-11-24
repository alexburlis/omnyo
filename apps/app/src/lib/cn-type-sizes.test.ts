import { describe, expect, it } from "vitest";
import { cn } from "@omnyo/shared-ui/lib/utils";

describe("cn", () => {
  it("keeps sanctioned type sizes beside text colours", () => {
    for (const size of ["2xs", "prose", "lead", "display", "numeral"]) {
      expect(cn(`text-${size}`, "text-muted-foreground")).toBe(
        `text-${size} text-muted-foreground`,
      );
    }
  });

  it("lets a later sanctioned size replace an earlier one", () => {
    expect(cn("text-sm", "text-numeral")).toBe("text-numeral");
  });
});
