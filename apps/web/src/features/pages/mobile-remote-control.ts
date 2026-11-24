import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Answer your agents from your phone",
  lede: "Your chats keep running on your own computer, and the iPhone app or any browser lets you follow them, get notified and reply.",
  sections: [
    {
      heading: "Pair your phone with one code",
      body: "Sign your Omnyo server in to a free Omnyo account and it gets an address like `you.omnyo.link`. Add a mobile device in Settings → Mobile and scan the code with the iPhone app.",
      bullets: [
        "Codes last 10 minutes and work once",
        "Revoke a lost phone from the omnyo.link dashboard",
        "Prefer your own network? Use Tailscale Serve instead",
      ],
      visual: "remote-pair",
    },
    {
      heading: "A push when a chat needs you",
      body: "The iPhone app gets a push when a chat finishes, needs your input or fails. While the desktop app sees you at your computer, pushes wait until you step away.",
      bullets: ["Per chat: All activity, Needs input only or Muted"],
      visual: "remote-push",
    },
    {
      heading: "Check what your agent is building",
      body: "When an agent registers a [dev server](/features/dev-servers), you can open it on the phone too. Omnyo serves it through a private preview link on your own server.",
      bullets: [],
      visual: "dev-servers-phone",
    },
  ],
  goodToKnow: [
    {
      label: "Runs on",
      value:
        "Your own computer. While it sleeps or is off, nothing can reach Omnyo.",
    },
    {
      label: "Keep Awake",
      value:
        "Keeps a Mac or Windows computer awake. It starts off, and a closed Mac lid still sleeps.",
    },
    {
      label: "Encryption",
      value:
        "Omnyo connect uses HTTPS to a relay that terminates TLS. It is not end-to-end encrypted.",
    },
    {
      label: "Account",
      value: "Omnyo connect needs a free Omnyo account, signed in with GitHub.",
    },
    {
      label: "Platforms",
      value: "iPhone app, or any phone browser. Android app coming soon.",
    },
  ],
  faq: [
    {
      question: "Can I use Claude Code from my phone?",
      answer:
        "Yes, through Omnyo. Claude Code runs as an Omnyo chat on your own computer, and the iPhone app or a phone browser lets you read it and reply. Codex chats work the same way.",
    },
    {
      question: "Is this Claude Code's own Remote Control?",
      answer:
        "No. Remote Control is Anthropic's feature. Omnyo connects your phone to your own Omnyo server, which runs your Claude Code and Codex chats.",
    },
    {
      question: "Can I keep traffic off the relay?",
      answer:
        "Yes. Publish Omnyo with Tailscale Serve and open that address on your phone. Traffic then stays on your own Tailscale network.",
    },
  ],
  relatedFeatures: ["devices", "notifications", "dev-servers"],
  relatedGuides: [
    {
      slug: "work-from-anywhere",
      label: "Work from anywhere",
    },
  ],
};
