// @vitest-environment jsdom
import { Activity, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import type { Editor, TiptapEditorHTMLElement } from "@tiptap/core";
import { orderPromptMentionSuggestions } from "@/hooks/promptMentionCandidates";
import type { PromptTextMention } from "@omnyo/domain";
import { PromptBoxInternal, type TypeaheadConfig } from "./PromptBoxInternal";

const nativeHost = vi.hoisted(() => ({ localHostId: "host-local" }));

// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock("@/hooks/useHostDaemon", () => ({ useHostDaemon: () => nativeHost }));

const typeahead: TypeaheadConfig = {
  mention: {
    results: orderPromptMentionSuggestions({ query: "", suggestions: [] }),
    isLoading: false,
    isRefreshing: false,
    isError: false,
    onQueryChange: () => {},
  },
  command: {
    triggers: ["/"],
    suggestions: [],
    isLoading: false,
    isError: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: () => {},
    onQueryChange: () => {},
  },
};

const stored = { text: "" };

function StoredPromptBox() {
  const [value, setValue] = useState(stored.text);
  const [mentions, setMentions] = useState<PromptTextMention[]>([]);

  return (
    <PromptBoxInternal
      value={value}
      mentionRanges={mentions}
      onChange={(nextValue, nextMentions) => {
        stored.text = nextValue;
        setValue(nextValue);
        setMentions(nextMentions);
      }}
      onSubmit={() => {}}
      typeahead={typeahead}
      mentionMenuPlacement="bottom"
    />
  );
}

function KeptChat({ visible }: { visible: boolean }) {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <Activity mode={visible ? "visible" : "hidden"}>
          <StoredPromptBox />
        </Activity>
      </TooltipProvider>
    </MemoryRouter>
  );
}

function currentEditor(): Editor {
  const element = document.querySelector(".ProseMirror");

  const editor =
    element instanceof HTMLElement
      ? (element as TiptapEditorHTMLElement).editor
      : undefined;

  if (!editor) throw new Error("Prompt editor was not rendered");

  return editor;
}

function settle(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

afterEach(() => {
  cleanup();
  stored.text = "";
});

describe("PromptBoxInternal inside a kept chat view", () => {
  it("keeps typed text after the chat is hidden and shown again", async () => {
    const view = render(<KeptChat visible />);
    await settle();

    act(() => {
      currentEditor().commands.insertContent("unsent words");
    });
    expect(stored.text).toBe("unsent words");

    await settle();

    for (let round = 0; round < 3; round += 1) {
      view.rerender(<KeptChat visible={false} />);
      await settle();
      view.rerender(<KeptChat visible />);
      await settle();

      expect(stored.text).toBe("unsent words");
      expect(currentEditor().getText()).toBe("unsent words");
    }

    act(() => {
      currentEditor().chain().focus("end").insertContent(" and more").run();
    });
    expect(stored.text).toBe("unsent words and more");
  });
});
