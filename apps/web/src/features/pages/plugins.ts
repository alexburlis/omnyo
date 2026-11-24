import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Change any part of Omnyo by asking",
  lede: "Pick a part of the app, describe what you want, and your own Claude Code or Codex agent builds it as a setting, a theme or a plugin.",
  sections: [
    {
      heading: "Six themes, or your own CSS",
      body: "Settings → Appearance sets System, Light or Dark and a palette: Default, Nord, Dracula, Solarized, Gruvbox or Catppuccin. A custom theme is a single theme.css file, and plugins can add more.",
      bullets: [
        "`omnyo theme` lists, sets, shows and resets themes",
        "The Theme Preview plugin repaints live as you edit",
      ],
      visual: "plugins-themes",
    },
    {
      heading: "Build your own plugin",
      body: "A plugin can add panels, settings, file viewers and command palette actions, plus CLI commands, agent tools and providers. Much of Omnyo itself is plugins you can switch off.",
      bullets: [
        "`omnyo plugin new` scaffolds a plugin",
        "`omnyo plugin dev` rebuilds and reloads it on every save",
        "`omnyo plugin safe-mode on` stops every plugin you installed",
      ],
      visual: "plugins-dev",
    },
  ],
  goodToKnow: [
    {
      label: "Customizer",
      value:
        "Starts a normal chat with the picked part's text and position attached. Form values are left out.",
    },
    {
      label: "Cost",
      value: "Uses your own Claude Code or Codex subscription, like any chat.",
    },
    {
      label: "Install from",
      value: "The Omnyo Official catalog, a Git URL, a local folder or npm.",
    },
    {
      label: "Core plugins",
      value:
        "Can be switched off, not removed. The app shell, server and Inbox are not plugins.",
    },
    {
      label: "Instructions",
      value:
        "Custom instructions, up to 4,096 characters, reach every agent on that host.",
    },
    {
      label: "Plugin SDK",
      value: "Documented in the bundled Plugin Guide. Not published on npm.",
    },
  ],
  faq: [
    {
      question: "Can I change the theme of my Claude Code chats?",
      answer:
        "Yes. A theme styles the whole Omnyo app, so it applies to every chat, whether it runs Claude Code or Codex. Pick a built-in palette or write your own CSS file.",
    },
    {
      question: "What can the Customizer change?",
      answer:
        "Anything your agent can build with settings, themes and plugin slots. It works on any visible part of the app except content inside embedded browser frames.",
    },
    {
      question: "What if a plugin breaks Omnyo?",
      answer:
        "Run `omnyo plugin safe-mode on` to stop every plugin you installed, or switch a single plugin off on its details page.",
    },
    {
      question: "Are third-party plugins reviewed?",
      answer:
        "No. Only the bundled Omnyo Official catalog is. Other marketplaces are labelled as not reviewed, and the install prompt names the author and exact source.",
    },
  ],
  relatedFeatures: ["open-source", "keyboard", "canvas"],
  relatedGuides: [],
};
