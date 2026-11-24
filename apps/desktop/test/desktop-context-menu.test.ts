import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  buildDesktopContextMenuTemplate,
  registerDesktopContextMenu,
  type DesktopContextMenuWebContents,
} from "../src/desktop-context-menu.js";

const popup = vi.fn();

const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: {
    writeText: writeClipboardText,
  },
  Menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]) {
      return { popup, template };
    },
  },
}));

const DEFAULT_EDIT_FLAGS = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
} satisfies ContextMenuParams["editFlags"];

const DEFAULT_MEDIA_FLAGS = {
  inError: false,
  isPaused: false,
  isMuted: false,
  hasAudio: false,
  isLooping: false,
  isControlsVisible: false,
  canToggleControls: false,
  canPrint: false,
  canSave: false,
  canShowPictureInPicture: false,
  isShowingPictureInPicture: false,
  canRotate: false,
  canLoop: false,
} satisfies ContextMenuParams["mediaFlags"];

interface FakeWebContents extends Pick<
  DesktopContextMenuWebContents,
  "replaceMisspelling" | "session"
> {
  addedDictionaryWords: string[];
  replacedMisspellings: string[];
  spellCheckerEnabledValues: boolean[];
  downloadedUrls: string[];
  copiedImagePositions: Array<{ x: number; y: number }>;
  destroyed: boolean;
  downloadURL(url: string): void;
  copyImageAt(x: number, y: number): void;
  isDestroyed(): boolean;
}

function createContextMenuParams(
  overrides: Partial<ContextMenuParams> = {},
): ContextMenuParams {
  return {
    x: 0,
    y: 0,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "",
    frameURL: "",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    titleText: "",
    altText: "",
    suggestedFilename: "",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: "default", url: "" },
    misspelledWord: "",
    dictionarySuggestions: [],
    frameCharset: "utf-8",
    formControlType: "none",
    spellcheckEnabled: false,
    menuSourceType: "mouse",
    mediaFlags: DEFAULT_MEDIA_FLAGS,
    editFlags: DEFAULT_EDIT_FLAGS,
    ...overrides,
  };
}

function createFakeWebContents(): FakeWebContents {
  const addedDictionaryWords: string[] = [];
  const replacedMisspellings: string[] = [];
  const spellCheckerEnabledValues: boolean[] = [];
  const downloadedUrls: string[] = [];
  const copiedImagePositions: Array<{ x: number; y: number }> = [];

  return {
    addedDictionaryWords,
    replacedMisspellings,
    spellCheckerEnabledValues,
    downloadedUrls,
    copiedImagePositions,
    destroyed: false,
    downloadURL(url) {
      downloadedUrls.push(url);
    },
    copyImageAt(x, y) {
      copiedImagePositions.push({ x, y });
    },
    isDestroyed() {
      return this.destroyed;
    },
    replaceMisspelling(text) {
      replacedMisspellings.push(text);
    },
    session: {
      addWordToSpellCheckerDictionary(word) {
        addedDictionaryWords.push(word);

        return true;
      },
      setSpellCheckerEnabled(enabled) {
        spellCheckerEnabledValues.push(enabled);
      },
    },
  };
}

function clickMenuItem(item: MenuItemConstructorOptions | undefined): void {
  item?.click?.(undefined as never, undefined as never, undefined as never);
}

describe("desktop context menu", () => {
  it("uses Electron's spelling result even when spellcheckEnabled is false", () => {
    const webContents = createFakeWebContents();

    const params = createContextMenuParams({
      formControlType: "input-text",
      isEditable: true,
      spellcheckEnabled: false,
      misspelledWord: "teh",
      dictionarySuggestions: ["the", "tech"],
    });

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params,
    });

    expect(template[0]).toMatchObject({ label: "the" });
    expect(template[1]).toMatchObject({ label: "tech" });

    clickMenuItem(template[0]);

    expect(webContents.replacedMisspellings).toEqual(["the"]);
  });

  it("can add a misspelled word to the spellchecker dictionary", () => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        isEditable: true,
        spellcheckEnabled: true,
        misspelledWord: "bbapp",
      }),
    });

    expect(template[0]).toMatchObject({
      label: "No Spelling Suggestions",
      enabled: false,
    });
    expect(template[1]).toMatchObject({
      label: 'Add "bbapp" to Dictionary',
    });

    clickMenuItem(template[1]);

    expect(webContents.addedDictionaryWords).toEqual(["bbapp"]);
  });

  it("keeps standard edit actions in editable context menus", () => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        isEditable: true,
        editFlags: {
          ...DEFAULT_EDIT_FLAGS,
          canCopy: true,
          canPaste: true,
          canSelectAll: true,
        },
      }),
    });

    expect(template).toEqual([
      { role: "undo", enabled: false },
      { role: "redo", enabled: false },
      { type: "separator" },
      { role: "cut", enabled: false },
      { role: "copy", enabled: true },
      { role: "paste", enabled: true },
      { role: "delete", enabled: false },
      { type: "separator" },
      { role: "selectAll", enabled: true },
    ]);
  });

  it("copies a link target", () => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        linkURL: "https://example.com/device",
      }),
    });

    expect(template).toEqual([
      { label: "Copy Link", click: expect.any(Function) },
      { label: "Save Link As…", click: expect.any(Function) },
    ]);

    clickMenuItem(template[0]);

    expect(writeClipboardText).toHaveBeenCalledWith(
      "https://example.com/device",
    );
  });

  it("groups selected-text actions together", () => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        selectionText: "device authorization",
        editFlags: {
          ...DEFAULT_EDIT_FLAGS,
          canCopy: true,
          canSelectAll: true,
        },
      }),
    });

    expect(template).toEqual([
      { role: "copy", enabled: true },
      { role: "selectAll", enabled: true },
    ]);
  });

  it("preserves selected-text actions for links", () => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        linkURL: "https://example.com/device",
        selectionText: "device authorization",
        editFlags: {
          ...DEFAULT_EDIT_FLAGS,
          canCopy: true,
          canSelectAll: true,
        },
      }),
    });

    expect(template).toMatchObject([
      { label: "Copy Link" },
      { label: "Save Link As…" },
      { type: "separator" },
      { role: "copy", enabled: true },
      { role: "selectAll", enabled: true },
    ]);
  });

  it("does not show an empty menu for inert content", () => {
    const webContents = createFakeWebContents();

    expect(
      buildDesktopContextMenuTemplate({
        webContents,
        params: createContextMenuParams(),
      }),
    ).toEqual([]);
  });

  it("saves a generated private host image through its owning web contents and copies its image pixels", () => {
    const webContents = createFakeWebContents();

    const srcURL =
      "https://omnyo.example/api/v1/threads/thr_example/host-files/C%3A/outputs/generated%20image.png";

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        mediaType: "image",
        hasImageContents: true,
        srcURL,
        x: 67,
        y: 89,
      }),
    });

    clickMenuItem(template.find((item) => item.label === "Save Image As…"));
    clickMenuItem(template.find((item) => item.label === "Copy Image"));

    expect(webContents.downloadedUrls).toEqual([srcURL]);
    expect(webContents.copiedImagePositions).toEqual([{ x: 67, y: 89 }]);
  });

  it("keeps image, link and selected-text actions available on a linked image", () => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        mediaType: "image",
        hasImageContents: true,
        srcURL: "https://omnyo.example/generated.png",
        linkURL: "https://omnyo.example/generated-original.png",
        selectionText: "Generated result",
        editFlags: { ...DEFAULT_EDIT_FLAGS, canCopy: true, canSelectAll: true },
      }),
    });

    for (const label of [
      "Save Image As…",
      "Copy Image",
      "Copy Link",
      "Save Link As…",
    ])
      expect(template.find((item) => item.label === label)).toBeDefined();
    expect(template).toContainEqual({ role: "copy", enabled: true });
    expect(template).toContainEqual({ role: "selectAll", enabled: true });
    expect(template[0]?.type).not.toBe("separator");
    expect(template.at(-1)?.type).not.toBe("separator");
    expect(
      template.some(
        (item, index) =>
          item.type === "separator" &&
          template[index + 1]?.type === "separator",
      ),
    ).toBe(false);
  });

  it("passes the exact private linked file URL to the owning download path", () => {
    const webContents = createFakeWebContents();

    const linkURL =
      "https://omnyo.example/api/v1/environments/env_example/files/results/report%20final.pdf";

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({ linkURL }),
    });

    clickMenuItem(template.find((item) => item.label === "Save Link As…"));

    expect(webContents.downloadedUrls).toEqual([linkURL]);
  });

  it.each([
    "data:image/png;base64,iVBORw0KGgo=",
    "blob:https://omnyo.example/3d87c94c-5e0c-4440-b751-c75906c90001",
  ])("saves a loaded image using the proven %s native URL path", (srcURL) => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        mediaType: "image",
        hasImageContents: true,
        srcURL,
      }),
    });

    clickMenuItem(template.find((item) => item.label === "Save Image As…"));

    expect(webContents.downloadedUrls).toEqual([srcURL]);
  });

  it.each([
    "javascript:alert(1)",
    "file:///C:/private/generated.png",
    "omnyo://open/private-file",
    "data:text/html,<script>alert(1)</script>",
    "not a URL",
  ])("does not download an unsafe source %s", (srcURL) => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        mediaType: "image",
        hasImageContents: true,
        srcURL,
        linkURL: srcURL,
      }),
    });

    expect(
      template.find((item) => item.label === "Save Image As…"),
    ).toBeUndefined();
    expect(
      template.find((item) => item.label === "Save Link As…"),
    ).toBeUndefined();
  });

  it.each([
    {
      mediaType: "image",
      hasImageContents: false,
      srcURL: "https://omnyo.example/broken.png",
    },
    { mediaType: "image", hasImageContents: true, srcURL: "" },
    {
      mediaType: "none",
      hasImageContents: false,
      srcURL: "https://omnyo.example/not-an-image",
    },
  ] satisfies Array<Partial<ContextMenuParams>>)(
    "does not offer image saves for unloaded media $srcURL",
    (params) => {
      const template = buildDesktopContextMenuTemplate({
        webContents: createFakeWebContents(),
        params: createContextMenuParams(params),
      });

      expect(
        template.find((item) => item.label === "Save Image As…"),
      ).toBeUndefined();
    },
  );

  it("ignores a stale image action after its owning web contents is destroyed", () => {
    const webContents = createFakeWebContents();

    const template = buildDesktopContextMenuTemplate({
      webContents,
      params: createContextMenuParams({
        mediaType: "image",
        hasImageContents: true,
        srcURL: "https://omnyo.example/generated.png",
      }),
    });

    const save = template.find((item) => item.label === "Save Image As…");
    const copy = template.find((item) => item.label === "Copy Image");
    expect(save).toBeDefined();
    expect(copy).toBeDefined();
    webContents.destroyed = true;

    clickMenuItem(save);
    clickMenuItem(copy);

    expect(webContents.downloadedUrls).toEqual([]);
    expect(webContents.copiedImagePositions).toEqual([]);
  });

  it("registers the native menu popup for context-menu events", async () => {
    const webContents = {
      ...createFakeWebContents(),
      on: vi.fn(),
    } satisfies DesktopContextMenuWebContents;

    registerDesktopContextMenu({ webContents });

    expect(webContents.spellCheckerEnabledValues).toEqual([true]);

    const listener = webContents.on.mock.calls[0]?.[1];
    listener?.(
      undefined as never,
      createContextMenuParams({
        selectionText: "selected",
        editFlags: { ...DEFAULT_EDIT_FLAGS, canCopy: true },
      }),
    );

    await Promise.resolve();

    expect(popup).toHaveBeenCalledOnce();
  });
});
