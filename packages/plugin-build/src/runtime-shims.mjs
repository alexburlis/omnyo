export const PLUGIN_SDK_APP_SPECIFIER = "@omnyo/plugin-sdk/app";

export const SHARED_UI_ICON_SPECIFIER = "@omnyo/shared-ui/icon";

export const SHARED_UI_QUESTION_FORM_HOST_SPECIFIER =
  "@omnyo/shared-ui/question-form-host";

export const SHARED_UI_VOICE_INPUT_TEXTAREA_SPECIFIER =
  "@omnyo/shared-ui/voice-input-textarea";

export const RUNTIME_SLOT_BY_SPECIFIER = Object.freeze({
  react: "react",
  "react-dom": "reactDom",
  "react-dom/client": "reactDomClient",
  "react/jsx-runtime": "jsxRuntime",
  "react/jsx-dev-runtime": "jsxDevRuntime",
  [PLUGIN_SDK_APP_SPECIFIER]: "pluginSdkApp",
  "@pierre/diffs": "pierreDiffs",
  "@pierre/diffs/react": "pierreDiffsReact",
  "@radix-ui/react-alert-dialog": "radixAlertDialog",
  "@radix-ui/react-context-menu": "radixContextMenu",
  "@radix-ui/react-dialog": "radixDialog",
  "@radix-ui/react-dropdown-menu": "radixDropdownMenu",
  "@radix-ui/react-hover-card": "radixHoverCard",
  "@radix-ui/react-menubar": "radixMenubar",
  "@radix-ui/react-navigation-menu": "radixNavigationMenu",
  "@radix-ui/react-popover": "radixPopover",
  "@radix-ui/react-select": "radixSelect",
  "@radix-ui/react-tooltip": "radixTooltip",
  sonner: "sonner",
  vaul: "vaul",
  clsx: "clsx",
  "tailwind-merge": "tailwindMerge",
  "class-variance-authority": "classVarianceAuthority",
  [SHARED_UI_ICON_SPECIFIER]: "sharedUiIcon",
  [SHARED_UI_QUESTION_FORM_HOST_SPECIFIER]: "questionFormHost",
  [SHARED_UI_VOICE_INPUT_TEXTAREA_SPECIFIER]: "voiceInputTextarea",
});

function packageNameOf(specifier) {
  const segments = specifier.split("/");

  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

const NON_NPM_SHIM_PACKAGES = new Set([
  packageNameOf(PLUGIN_SDK_APP_SPECIFIER),
  packageNameOf(SHARED_UI_ICON_SPECIFIER),
]);

export const RUNTIME_SHIM_NPM_SPECIFIERS = Object.freeze(
  Object.keys(RUNTIME_SLOT_BY_SPECIFIER).filter(
    (specifier) => !NON_NPM_SHIM_PACKAGES.has(packageNameOf(specifier)),
  ),
);

export const SHIMMED_TYPE_PACKAGES = Object.freeze(
  [
    ...new Set(
      RUNTIME_SHIM_NPM_SPECIFIERS.map(packageNameOf).filter(
        (name) => name !== "react" && name !== "react-dom",
      ),
    ),
  ].sort(),
);
