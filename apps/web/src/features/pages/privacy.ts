import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Your chats stay on a server you run",
  lede: "Omnyo stores chats on your own computer. Your AI provider processes your prompts. Here’s what Omnyo can send when you use predictions, voice input, or remote access.",
  sections: [
    {
      heading: "No Omnyo account, no Omnyo cloud",
      body: "One of your computers runs the Omnyo server and keeps the chats, database and settings. Setup needs no Omnyo account, and Omnyo runs no AI service and resells no tokens.",
      bullets: [
        "Claude Code chats go to Anthropic under your sign-in",
        "Codex chats go to OpenAI the same way",
      ],
      visual: "self-hosted",
    },
    {
      heading: "Remote access is optional",
      body: "Omnyo connect gives your server an address through a relay. The relay terminates TLS, so it is not end-to-end encrypted. Tailscale Serve keeps the traffic on your own network instead.",
      bullets: [
        "Connect needs a free account with GitHub sign-in",
        "The relay stores no request bodies",
        "`omnyo connect off` closes the tunnel",
      ],
      visual: "devices-routes",
    },
    {
      heading: "Diagnostics you can switch off",
      body: "Updated builds have separate controls for Weekly activity count, Product analytics for this client and Crash reports. Product analytics needs your explicit choice, and turning a purpose off stops new reports.",
      bullets: ["Streamer mode hides custom model names on screen shares"],
      visual: "privacy-diagnostics",
    },
  ],
  goodToKnow: [
    {
      label: "Predictions",
      value:
        "From Omnyo 1.0.184, Same chat uses the current agent by default. Older versions and the Fixed Codex setting can send context from completed chats to OpenAI, including Claude chats.",
    },
    {
      label: "Voice",
      value:
        "Dictation by Paraspeech transcribes on the Mac running your server. Older versions could use Codex cloud transcription when Dictation was unavailable.",
    },
    {
      label: "Push",
      value: "Phone notifications pass through Expo and Apple's push service.",
    },
    {
      label: "Stats",
      value: "Token counts only, stored in SQLite on your server.",
    },
    {
      label: "Full details",
      value:
        "In the [privacy policy](/privacy), including what the relay sees.",
    },
  ],
  faq: [
    {
      question:
        "Does Claude Code send my code to Anthropic when I use it in Omnyo?",
      answer:
        "Yes. Omnyo runs the Claude Code CLI with your own sign-in, so prompts and the files the agent reads go to Anthropic under your account, exactly as they would in a terminal.",
    },
    {
      question: "Do I need an Omnyo account?",
      answer:
        "Not on your own machines. An account is only for Omnyo connect, the optional relay for remote access.",
    },
    {
      question: "Is remote access end-to-end encrypted?",
      answer:
        "Not through Omnyo connect, because the relay terminates TLS and its operator could technically read the traffic. Tailscale Serve keeps traffic on your own network instead.",
    },
    {
      question: "Can I turn off reply suggestions?",
      answer: "Yes. Turn off Composer predictions in the plugin’s settings.",
    },
  ],
  relatedFeatures: ["open-source", "devices", "usage-tracking"],
  relatedGuides: [{ slug: "work-from-anywhere", label: "Work from anywhere" }],
};
