import { describe, expect, it, vi } from "vitest";
import {
  notifyComposerSubmitted,
  subscribeComposerSubmitted,
} from "./composer-submissions";

describe("composer submissions", () => {
  it("carries only the accepted immutable revision to the originating composer", () => {
    const listener = vi.fn();
    const scope = { kind: "thread" as const, threadId: "accepted" };
    const dispose = subscribeComposerSubmitted(scope, listener);

    const draft = {
      text: "@note",
      mentions: [
        {
          kind: "plugin" as const,
          pluginId: "annotations",
          provider: "annotation",
          id: "immutable-old",
          label: "note",
          from: 0,
          to: 5,
        },
      ],
      attachments: [],
    };

    notifyComposerSubmitted(scope, draft);
    expect(listener).toHaveBeenCalledWith(draft);
    expect(listener.mock.calls[0]?.[0]?.mentions[0]?.id).toBe("immutable-old");
    dispose();
  });

  it("scopes notifications and disposes listeners", () => {
    const listener = vi.fn();

    const dispose = subscribeComposerSubmitted(
      { kind: "thread", threadId: "one" },
      listener,
    );

    notifyComposerSubmitted({ kind: "thread", threadId: "two" });
    expect(listener).not.toHaveBeenCalled();
    notifyComposerSubmitted({ kind: "thread", threadId: "one" });
    expect(listener).toHaveBeenCalledOnce();
    dispose();
    notifyComposerSubmitted({ kind: "thread", threadId: "one" });
    expect(listener).toHaveBeenCalledOnce();
  });
});
