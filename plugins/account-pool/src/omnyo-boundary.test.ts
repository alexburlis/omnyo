import { expect, it } from "vitest";
import {
  parentRequestHeaders,
  readParentPool,
  readHubHeaderV1,
} from "./parent-pool.js";

const parentUrl = "https://parent.example.invalid/pool";

const syntheticToken = "x".repeat(43);

it("reads canonical parent routing credentials without detaching the pool", () => {
  expect(
    readParentPool({
      OMNYO_ACCOUNT_POOL_PARENT_URL: parentUrl,
      OMNYO_ACCOUNT_POOL_PARENT_TOKEN: syntheticToken,
    }),
  ).toEqual({ baseUrl: parentUrl, token: syntheticToken });
});

it("refuses partially configured or malformed parent routing", () => {
  for (const values of [
    { OMNYO_ACCOUNT_POOL_PARENT_URL: parentUrl },
    { OMNYO_ACCOUNT_POOL_PARENT_TOKEN: syntheticToken },
    {
      OMNYO_ACCOUNT_POOL_PARENT_URL: "not-a-url",
      OMNYO_ACCOUNT_POOL_PARENT_TOKEN: syntheticToken,
    },
  ])
    expect(() => readParentPool(values)).toThrow(
      "Invalid parent pool environment",
    );
  expect(readParentPool({})).toBeNull();
});
