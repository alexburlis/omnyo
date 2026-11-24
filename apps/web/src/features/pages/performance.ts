import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Four timings, each with its method",
  lede: "Every number here comes from Omnyo's own tests on one M4 Pro Mac in October 2026, with what was timed and where the clock stopped.",
  sections: [
    {
      heading: "Switch chats in under 100 ms",
      body: "From the pointer press to the first frame showing the new chat's messages, all 20 switches to recently opened chats took 85 ms or less. The test ran in Chrome with the network held off.",
      bullets: [
        "Covers chats already cached in memory",
        "Cmd+↓ and Cmd+↑ step to the next and previous chat",
      ],
      visual: "performance-switch",
    },
    {
      heading: "A 15,000-event chat reopens in 25 ms",
      body: "The server read of a 116 MB chat with 15,543 events took a median of 25 ms over 20 reopens, down from about 1.8 s before the change it tested. Drawing it on screen comes on top.",
      bullets: [
        "A new chat saves in about 6 ms (median of 30)",
        "Search across 1,000 chats takes about 3 ms",
      ],
      visual: "performance-reopen",
    },
    {
      heading: "Archive lands in the same frame",
      body: "Archiving or shelving a chat in the Inbox plays no animation, so the change shows in the same frame. Archive has never been timed, so there is no millisecond figure for it.",
      bullets: ["Cmd/Ctrl+Z undoes an archive"],
      visual: "inbox-keys",
    },
  ],
  goodToKnow: [
    {
      label: "Machine",
      value: "One M4 Pro Mac, local tests, October 2026.",
    },
    {
      label: "Clock stops",
      value:
        "On screen for the switch. At the server's answer for the other three.",
    },
    {
      label: "Not measured",
      value: "Windows, phones, production, app cold start and archive.",
    },
    {
      label: "AI time",
      value: "Excluded. The tests ran with no AI provider attached.",
    },
    {
      label: "Comparisons",
      value: "None. Omnyo has not tested any other app.",
    },
  ],
  faq: [
    {
      question: "Will I see the same numbers on my machine?",
      answer:
        "Not necessarily. Every result comes from one M4 Pro Mac in a local test in October 2026, and no Windows, phone or production measurement exists.",
    },
    {
      question: "Is Omnyo faster than other coding agent apps?",
      answer:
        "Omnyo has not tested any other product, so it makes no comparison. The only before-and-after figure compares Omnyo with an earlier version of itself.",
    },
    {
      question: "How long does the app take to start?",
      answer:
        "The desktop app's cold start has never been measured, so there is no figure for it.",
    },
  ],
  relatedFeatures: ["keyboard", "inbox", "stats"],
  relatedGuides: [],
};
