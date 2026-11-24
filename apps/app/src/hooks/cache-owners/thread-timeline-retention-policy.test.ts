import { describe, expect, it } from "vitest";
import { selectTimelineCacheEvictions } from "./thread-timeline-retention-policy";

const MiB = 1024 * 1024;

describe("complete timeline retention", () => {
  it.each([511, 512])(
    "retains initialized timelines totaling %i MiB",
    (size) => {
      expect(
        selectTimelineCacheEvictions([
          {
            threadId: "chat",
            bytes: size * MiB,
            active: false,
            retained: true,
          },
        ]),
      ).toEqual([]);
    },
  );

  it("evicts only the oldest inactive timeline needed to reach the ceiling", () => {
    expect(
      selectTimelineCacheEvictions([
        { threadId: "oldest", bytes: MiB, active: false, retained: true },
        {
          threadId: "current",
          bytes: 512 * MiB,
          active: false,
          retained: true,
        },
      ]),
    ).toEqual(["oldest"]);
  });

  it("releases archived timelines before older unarchived conversations", () => {
    expect(
      selectTimelineCacheEvictions([
        {
          threadId: "unarchived",
          bytes: 400 * MiB,
          active: false,
          retained: true,
        },
        {
          threadId: "archived",
          bytes: 120 * MiB,
          active: false,
          retained: false,
        },
      ]),
    ).toEqual(["archived"]);
  });

  it("counts foreground data while protecting its active conversation", () => {
    expect(
      selectTimelineCacheEvictions([
        {
          threadId: "foreground",
          bytes: 400 * MiB,
          active: true,
          retained: true,
        },
        {
          threadId: "inactive",
          bytes: 200 * MiB,
          active: false,
          retained: true,
        },
      ]),
    ).toEqual(["inactive"]);
  });

  it("does not discard a foreground response that alone exceeds the ceiling", () => {
    expect(
      selectTimelineCacheEvictions([
        {
          threadId: "foreground",
          bytes: 513 * MiB,
          active: true,
          retained: true,
        },
      ]),
    ).toEqual([]);
  });
});
