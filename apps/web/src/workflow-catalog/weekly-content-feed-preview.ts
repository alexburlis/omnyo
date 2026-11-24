export const weeklyContentFeedPreview = {
  company: "Mosslight Workshop",
  context:
    "An illustrative week for a fictional startup helping neighborhood seed-swap organizers record seed names and planned swap dates.",
  evidence: [
    "Organizers can record seed names.",
    "Organizers can record planned swap dates.",
    "No supplied evidence supports customer counts, pricing, reminders or seed viability claims.",
  ],
  days: [
    {
      day: "Monday",
      topic: "The envelope that just says tomato",
      format: "Blog post",
      angle:
        "What to write when the person who saved the seeds remembers the plant better than the packet.",
    },
    {
      day: "Tuesday",
      topic: "Pick the date before the details",
      format: "Planning note",
      angle: "Record a planned swap date while the rest is still taking shape.",
    },
    {
      day: "Wednesday",
      topic: "What belongs on a seed label?",
      format: "Checklist",
      angle:
        "Separate a known seed name from details that still need checking.",
    },
    {
      day: "Thursday",
      topic: "An invitation with one clear next step",
      format: "Draft invitation",
      angle: "Ask neighbors to bring a seed name and suggest a swap date.",
    },
    {
      day: "Friday",
      topic: "Keep the unknowns visible",
      format: "Editorial note",
      angle:
        "Do not turn a missing variety or growing detail into a confident claim.",
    },
    {
      day: "Saturday",
      topic: "A small swap starts with a small list",
      format: "Getting-started guide",
      angle: "Record the seeds you know before planning a larger event.",
    },
    {
      day: "Sunday",
      topic: "Leave a useful note for next time",
      format: "Reflection prompt",
      angle:
        "Review seed names and planned dates before arranging another swap.",
    },
  ],
  draft: {
    title: "The envelope that just says tomato",
    paragraphs: [
      "Picture a kitchen table the night before a neighborhood seed swap. There’s a glossy packet of Sugar Ann peas, a jar marked calendula and a folded envelope with one word in pencil. Tomato. Which name goes on the list?",
      "Start with the pea packet. Copy “Sugar Ann pea” while the packet is in front of you. For the jar, “calendula” will do. The tomato is the interesting one. Someone at the table may remember a red fruit about the size of a plum. That’s a good detail to ask the grower about. It still leaves the variety open.",
      "Try reading the label as the person taking the envelope home. “Tomato, variety unknown” tells them exactly what they’re choosing. Leave a little room in pencil. If the neighbor who saved the seeds turns up with the original packet, you can fill in the name together.",
      "Keep the swap list just as plain. In Mosslight Workshop you can record “Sugar Ann pea”, “calendula” and “tomato, variety unknown”. Once the neighbors settle on a Saturday, record it as the planned swap date. Then send an invitation with a job small enough for anyone to say yes to. “Bring one envelope and tell us what you wrote on it.”",
    ],
  },
  review: {
    originalClaim: "Automatic reminders mean nobody misses swap day.",
    evidence:
      "The supplied facts cover seed names and planned dates. They do not mention reminders or attendance outcomes.",
    decision: "Revise: remove the unsupported reminder claim.",
    revision:
      "Once the neighbors settle on a Saturday, record it as the planned swap date.",
  },
};

export type WorkflowPreview = typeof weeklyContentFeedPreview;
