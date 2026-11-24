// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { makeTerminalSession } from "@/test/fixtures/terminal-sessions";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  parseComposerShellCommand,
  shellCommandInput,
  useComposerTerminal,
} from "./composer-terminal";

describe("composer shell commands", () => {
  it.each([
    ["! ls -la", "ls -la"],
    ["  !git status  ", "git status"],
    ["!python3 run.py ~/a.ts", "python3 run.py ~/a.ts"],
    ["!", ""],
    ["!\n", ""],
  ])("treats %j as a shell command", (text, command) => {
    expect(parseComposerShellCommand(text)).toBe(command);
  });

  it.each(["ls", "Run !this", "", "  "])(
    "keeps %j as a chat message",
    (text) => {
      expect(parseComposerShellCommand(text)).toBeNull();
    },
  );

  it("submits every line of a multi-line command with Enter", () => {
    expect(shellCommandInput("cd /tmp\r\necho hi\nls")).toBe(
      "cd /tmp\recho hi\rls\r",
    );
  });
});

describe("Ctrl+C in the composer terminal", () => {
  const session = makeTerminalSession({
    id: "term_chat",
    threadId: "thr_test",
  });

  async function renderTerminal(
    foreground: Awaited<ReturnType<typeof sdk.terminals.foreground>>,
  ) {
    localStorage.setItem(
      "omnyo.composerTerminals",
      JSON.stringify({ thr_test: session.id }),
    );
    vi.spyOn(sdk.terminals, "list").mockResolvedValue({ sessions: [session] });

    const foregroundCheck = vi
      .spyOn(sdk.terminals, "foreground")
      .mockResolvedValue(foreground);

    const close = vi
      .spyOn(sdk.terminals, "close")
      .mockResolvedValue({ ...session, status: "exited" });

    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useComposerTerminal("thr_test"), {
      wrapper,
    });

    await waitFor(() => expect(result.current?.session?.id).toBe(session.id));

    const press = async (data: string) => {
      const forward = vi.fn();
      let intercepted = false;
      await act(async () => {
        intercepted = result.current?.interceptInput(data, forward) ?? false;
      });

      return { forward, intercepted };
    };

    return { close, foregroundCheck, press, result };
  }

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("closes an idle terminal on the second Ctrl+C at an empty prompt", async () => {
    const { close, press, result } = await renderTerminal({ state: "idle" });

    const first = await press("\u0003");
    expect(first.intercepted).toBe(true);
    await waitFor(() => expect(first.forward).toHaveBeenCalledOnce());
    expect(result.current?.closeHintShown).toBe(true);
    expect(close).not.toHaveBeenCalled();

    const second = await press("\u0003");
    await waitFor(() =>
      expect(close).toHaveBeenCalledWith({
        mode: "force",
        terminalId: session.id,
      }),
    );
    expect(second.forward).not.toHaveBeenCalled();
  });

  it("passes Ctrl+C to a running command and never closes", async () => {
    const { close, press, result } = await renderTerminal({
      state: "busy",
      command: "npm run dev",
    });

    for (let index = 0; index < 2; index += 1) {
      const { forward } = await press("\u0003");
      await waitFor(() => expect(forward).toHaveBeenCalledOnce());
    }

    expect(result.current?.closeHintShown).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("lets the first Ctrl+C clear typed text without counting it", async () => {
    const { foregroundCheck, press } = await renderTerminal({ state: "idle" });

    expect((await press("git sta")).intercepted).toBe(false);
    expect((await press("\u0003")).intercepted).toBe(false);
    expect(foregroundCheck).not.toHaveBeenCalled();
    expect((await press("\u0003")).intercepted).toBe(true);
  });
});
