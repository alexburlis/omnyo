import { expect, test } from "vitest";
import {
  assertSendOutboxEmptyForOriginTransferV1,
  type SendOutboxDatabaseProbe,
} from "./send-outbox-database";

function probe(args: {
  entries: number;
  exists: boolean;
}): SendOutboxDatabaseProbe & { counted: number } {
  const state = {
    counted: 0,
    async countEntries() {
      state.counted += 1;

      return args.entries;
    },
    async exists() {
      return args.exists;
    },
  };

  return state;
}

test("lets an address change proceed with no outbox or an empty one and refuses while messages wait", async () => {
  const absent = probe({ entries: 3, exists: false });
  const empty = probe({ entries: 0, exists: true });
  const waiting = probe({ entries: 2, exists: true });
  const single = probe({ entries: 1, exists: true });

  await expect(
    assertSendOutboxEmptyForOriginTransferV1(absent),
  ).resolves.toBeUndefined();
  await expect(
    assertSendOutboxEmptyForOriginTransferV1(empty),
  ).resolves.toBeUndefined();
  await expect(
    assertSendOutboxEmptyForOriginTransferV1(waiting),
  ).rejects.toThrow("2 messages are still waiting to send at this address");
  await expect(
    assertSendOutboxEmptyForOriginTransferV1(single),
  ).rejects.toThrow("1 message is still waiting to send at this address");
  expect(absent.counted).toBe(0);
});
