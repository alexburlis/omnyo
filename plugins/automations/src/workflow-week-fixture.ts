import type { WorkflowArtifactFile } from "../lib/workflow-week.js";

export const FIXTURE_LABEL =
  "Test data: Mosslight Workshop is the fictional default startup in the Weekly Content Feed template.";

const DRAFTS = [
  {
    id: "cand_a1",
    date: "2026-11-23",
    title: "Your seed list, ready before the swap",
    body: "Most seed swaps start with a scramble: who brought tomatoes, who promised beans, and whose envelope says *“mystery squash”*.\n\nMosslight Workshop lets members record seed names ahead of time, so organizers can see what is coming before the tables go up.\n\n- Add each variety once\n- Share the list with your swap group\n- Spend the morning trading, not tallying",
    reason:
      "Claims stay within the supplied facts. The list format suits a Monday planning post.",
  },
  {
    id: "cand_b2",
    date: "2026-11-24",
    title: "Plan the date, then plan the table",
    body: "A swap date is a promise to your neighbors. Mosslight Workshop keeps planned swap dates beside the seed list, so everyone sees the same calendar.\n\nWhen the date moves, the list moves with it.",
    reason: "Accurate and concise. No invented features.",
  },
  {
    id: "cand_c3",
    date: "2026-11-25",
    title: "Three questions to ask before a seed swap",
    body: "1. Which varieties are we short on?\n2. Who is bringing envelopes and labels?\n3. When is the next planned swap date?\n\nMosslight Workshop answers the first and third from the records members already keep.",
    reason:
      "Answers come only from features in the supplied facts. The numbered list reads well midweek.",
  },
  {
    id: "cand_d4",
    date: "2026-11-26",
    title: "Midweek: a quieter kind of organizing",
    body: "Not every organizer wants another group chat. Recording seed names in one place means fewer messages asking what is already covered.",
    reason: "Tone fits the audience. Claims supported.",
  },
  {
    id: "cand_e5",
    date: "2026-11-27",
    title: "Friday reminder for weekend swaps",
    body: "If your swap is this weekend, now is a good time to check the shared seed list and confirm the planned date with your group.",
    reason: "Timely and accurate.",
  },
  {
    id: "cand_f6",
    date: "2026-11-28",
    title: "What the table looked like last spring",
    body: "Organizers tell us the hardest part is remembering what traded well. Keeping seed names recorded between swaps makes next season’s planning a little easier.",
    reason:
      "Softened a testimonial into a general statement because no quote was supplied.",
  },
  {
    id: "cand_g7",
    date: "2026-11-29",
    title: "Sunday: start next week’s list",
    body: "A short list started on Sunday saves a long thread on Saturday. Open Mosslight Workshop, add two varieties you plan to bring, and you are ahead.",
    reason: "Clear call to action within supplied facts.",
  },
];

const DIGEST = "0".repeat(64);

export const FIXTURE_FILES: WorkflowArtifactFile[] = [
  ...DRAFTS.map((draft) => ({
    name: `${draft.id}.md`,
    content: `# ${draft.title}\n\n${draft.body}\n`,
  })),
  {
    name: "calendar.json",
    content: JSON.stringify(
      DRAFTS.map((draft) => ({
        date: draft.date,
        timezone: "Europe/Berlin",
        candidateId: draft.id,
        digest: DIGEST,
      })),
    ),
  },
  {
    name: "reviews.json",
    content: JSON.stringify(
      DRAFTS.map((draft) => ({
        candidateId: draft.id,
        draftDigest: DIGEST,
        outcome: "accepted",
        reason: draft.reason,
      })),
    ),
  },
];
