import { beforeAll } from "vitest";
import { warmTestHarness } from "../helpers/test-harness-warmup.js";

beforeAll(
  warmTestHarness,
  process.env.OMNYO_PERFORMANCE_SUITE === "1" ? 120_000 : undefined,
);
