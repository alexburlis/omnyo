import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Hear when an agent finishes or needs you",
  lede: "Omnyo tells you when a chat finishes, needs input or fails, and holds phone pushes while you are sitting at your computer.",
  sections: [
    {
      heading: "Your phone stays quiet at your desk",
      body: "While the desktop app sees you active, phone pushes wait. Lock the screen or step away and they go out, minus the chats you already read.",
      bullets: [
        "Active: under 2 minutes idle and the screen unlocked",
        "Unanswered questions still reach your phone",
      ],
      visual: "notifications-away",
    },
    {
      heading: "Choose how loud each chat is",
      body: "Set any chat to All activity, Needs input only or Muted from its menu. Sub-chats start at Needs input only, and a parent's level caps every chat below it.",
      bullets: [],
      visual: "notifications-levels",
    },
    {
      heading: "Sounds instead of banners",
      body: "Chime plays a short sound when a turn starts, completes, waits for an answer, needs approval or fails, and lights up that chat's row. Pick a theme or a sound per event.",
      bullets: ["Themes: Tap, Calm, Glass, Wood and Minimal"],
      visual: "notifications-chime",
    },
  ],
  goodToKnow: [
    {
      label: "Platforms",
      value:
        "iPhone push, Mac and Windows desktop notifications, and browser tabs.",
    },
    {
      label: "Needs",
      value:
        "The desktop app, to hold phone pushes. A browser tab alone sends every push.",
    },
    {
      label: "Finished",
      value:
        "Sent only once the chat and every sub-chat it started have no work left.",
    },
    {
      label: "In the app",
      value:
        "The chat you have open never notifies you. Other chats show a card you can answer.",
    },
    {
      label: "CLI",
      value: "`omnyo push-notifications test` sends a test notification.",
    },
  ],
  faq: [
    {
      question: "How do I get notified when Claude Code finishes a task?",
      answer:
        "Run the task in an Omnyo chat. Omnyo notifies you when it finishes, needs input or fails, on your iPhone, in the desktop app or in a browser tab.",
    },
    {
      question: "Do I need the Omnyo app open on my iPhone?",
      answer:
        "No. Pushes arrive with the app closed. They wait while the desktop app sees you active at your computer.",
    },
    {
      question: "Does an AI decide what reaches me?",
      answer:
        "No. The rules are fixed: chat state, your levels and whether you are at your computer. No model filters your notifications.",
    },
    {
      question: "Can I mute a noisy chat?",
      answer:
        "Yes. Pick Muted in the chat's Notifications menu. Muting a parent chat also quiets the sub-chats below it.",
    },
  ],
  relatedFeatures: ["inbox", "mobile-remote-control", "glance"],
  relatedGuides: [
    {
      slug: "work-from-anywhere",
      label: "Work from anywhere",
    },
  ],
};
