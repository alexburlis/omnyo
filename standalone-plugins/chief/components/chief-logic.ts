import type {
  DeckCardView,
  DeckView,
  DelegatedView,
  RuleView,
  SidebarStatus,
  Suggestions,
  ThreadDelegation,
} from "../lib/contract.ts";
import type { Verdict } from "../lib/inputs.ts";

export const HOME_PATH = "home";

export const NEEDS_YOU_TITLE = "Needs you";

export const ASSISTANT_TITLE = "Inbox assistant";

export const ROW_POLL_MS = 60_000;

export const CHANGE_DEBOUNCE_MS = 500;

export const ANSWERED_VISIBLE_MS = 10 * 60_000;

export const IDLE_TOOLTIP = "What your chats need from you, across all projects";

export const ERROR_TOOLTIP = "The Chief isn't responding";

export const PAUSED_TOOLTIP = "Answering for you is paused";

export const TALK_PLACEHOLDER = "Message the Chief";

export const TALK_LEAD = "Ask about your chats, or tell the Chief how you like things done.";

export const OFFER_TITLE = "Turn on answer suggestions?";

export const NO_AGENT_TEXT = "Connect a coding agent to get suggested answers.";

export const TIDY_HREF = "/plugins/tidy/tidy";

export const PROVIDERS_HREF = "/settings/providers";

export interface RowStatus {
  dot: "attention" | "failed" | null;
  tooltip: string | null;
  state: "paused" | "error" | null;
}

export type RowLoad = { kind: "loaded"; status: SidebarStatus } | { kind: "failed" };

export function rowStatus(load: RowLoad): RowStatus {
  if (load.kind === "failed" || load.status.error)
    return { dot: null, tooltip: ERROR_TOOLTIP, state: "error" };
  const { status } = load;
  const parts: string[] = [];

  if (status.toDecide > 0) parts.push(`${status.toDecide} to decide`);

  if (status.toDecide > 0 && status.saved > 0) parts.push(`${status.saved} saved for later`);

  if (status.paused) parts.push(PAUSED_TOOLTIP);

  return {
    dot: status.dot,
    tooltip: parts.length === 0 ? null : parts.join(" · "),
    state: status.paused ? "paused" : null,
  };
}

const CONFIDENCE_WORD: Record<Verdict["confidence"], string> = {
  high: "Sure",
  medium: "Fairly sure",
  low: "Unsure",
};

export function confidenceWord(confidence: Verdict["confidence"]): string {
  return CONFIDENCE_WORD[confidence];
}

const CONFIDENCE_RANK: Record<Verdict["confidence"], number> = { low: 0, medium: 1, high: 2 };

export function lowestConfidence(verdicts: readonly Verdict[]): Verdict["confidence"] | null {
  let lowest: Verdict["confidence"] | null = null;

  for (const verdict of verdicts)
    if (lowest === null || CONFIDENCE_RANK[verdict.confidence] < CONFIDENCE_RANK[lowest])
      lowest = verdict.confidence;

  return lowest;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function kindLabel(card: DeckCardView): string {
  if (
    card.ruleOffer &&
    card.steps.some((step) => step.question.options.some((option) => option.value === "resume"))
  )
    return "Resume answering?";

  if (card.ruleOffer)
    return card.steps.some((step) => {
      const values = step.question.options.map((option) => option.value);

      return values.includes("keep") && values.includes("reject");
    })
      ? "Keep this rule?"
      : "Make this a rule?";

  switch (card.kind) {
    case "question":
      return "Question";
    case "ask":
      return "Needs you";
    case "problem":
      return "Failed";
    case "result":
      return "Suggested reply";
  }
}

export function withSuggestions(
  cards: readonly DeckCardView[],
  suggestions: Suggestions,
): DeckCardView[] {
  if (suggestions === "on") return [...cards];

  return cards.map((card) => ({
    ...card,
    suggestedReply: null,
    steps: card.steps.map((step) => ({ ...step, verdict: null, triageError: null })),
  }));
}

export function visibleCards(
  cards: readonly DeckCardView[],
  suggestions: Suggestions,
  project: string | null,
): DeckCardView[] {
  return withSuggestions(cards, suggestions).filter(
    (card) =>
      (card.kind !== "result" || card.suggestedReply !== null) &&
      (project === null || card.ruleOffer || card.project === project),
  );
}

export function projectChips(cards: readonly DeckCardView[]): string[] {
  const projects = new Set<string>();

  for (const card of cards) if (!card.ruleOffer && card.project !== "") projects.add(card.project);

  return projects.size >= 2 ? [...projects].sort((a, b) => a.localeCompare(b)) : [];
}

export type StepNote =
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "reading" }
  | { kind: "none"; reason: string }
  | { kind: "hidden" };

export function stepNote(step: DeckCardView["steps"][number], suggestions: Suggestions): StepNote {
  if (suggestions !== "on") return { kind: "hidden" };

  if (step.verdict !== null) return { kind: "verdict", verdict: step.verdict };

  if (step.triageError !== null) return { kind: "none", reason: step.triageError };

  return { kind: "reading" };
}

export function offerText(agentLabel: string | null): string {
  return `Use your ${agentLabel ?? "coding agent"} account to read chat context and suggest answers across all projects.`;
}

export type FirstEmpty = "first-run" | "caught-up";

export function emptyKind(
  view: Pick<DeckView, "suggestions" | "saved" | "tabs" | "archiveReady">,
  answeredHere: boolean,
): FirstEmpty {
  const fresh =
    !answeredHere &&
    view.suggestions === "undecided" &&
    view.saved === 0 &&
    view.archiveReady === 0 &&
    !view.tabs.rules &&
    !view.tabs.decided;

  return fresh ? "first-run" : "caught-up";
}

export function showSwipeHint(view: Pick<DeckView, "swipeHintSeen" | "suggestions">, cards: number) {
  return !view.swipeHintSeen && view.suggestions === "on" && cards >= 2;
}

export function ageLabel(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);

  if (minutes < 1) return "now";

  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);

  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

export interface CardRow {
  title: string;
  preview: string | null;
  context: string | null;
}

function joinDistinct(parts: readonly string[]): string | null {
  const kept = [
    ...new Set(
      parts.flatMap((part) => {
        const trimmed = part.trim();

        return trimmed === "" ? [] : [trimmed];
      }),
    ),
  ];

  return kept.length === 0 ? null : kept.join(" · ");
}

export function cardRow(
  card: DeckCardView,
  review: Pick<DeckView["ruleReviews"][string], "topic" | "scope"> | undefined,
): CardRow {
  const step = card.steps[0];

  if (review !== undefined)
    return { title: review.topic, preview: step?.question.prompt ?? null, context: review.scope };

  if (card.kind === "question" && step !== undefined) {
    const label = step.question.shortLabel.trim();

    return {
      title: label === "" ? step.question.prompt : label,
      preview: label === "" ? step.question.context : step.question.prompt,
      context: joinDistinct([card.title, card.project]),
    };
  }

  const text = card.kind === "result" ? (card.suggestedReply ?? card.text) : card.text;

  return {
    title: card.title,
    preview: text.trim() === "" ? null : text,
    context: joinDistinct([card.project]),
  };
}

export function scopeText(scope: string): string {
  return scope === "All projects" || scope === "" ? "In all projects" : `In ${scope}`;
}

export function ruleText(rule: Pick<RuleView, "scope" | "cue" | "action">): string {
  return `${scopeText(rule.scope)} · When ${rule.cue}, ${rule.action}`;
}

export function levelLine(rule: Pick<RuleView, "level" | "required" | "state">): string {
  if (rule.state === "retired") return "Retired. Chats no longer follow it.";

  if (rule.state === "candidate") return "Not a rule yet. Answer its Make this a rule? question.";

  const which = rule.required ? "optional and required questions" : "optional questions";

  switch (rule.level) {
    case "ask":
      return "Chats follow it. The Chief only suggests.";
    case "veto":
      return `Chats follow it. The Chief answers ${which} after 10 minutes unless you stop it.`;
    case "auto":
      return `Chats follow it. The Chief answers ${which} at once.`;
  }
}

export function usageText(matches: number): string {
  if (matches === 0) return "Not used yet";

  return matches === 1 ? "Used once" : `Used ${matches} times`;
}

export type RuleLowering = "optional" | "ask" | "retire";

export function ruleLowerings(rule: Pick<RuleView, "level" | "required" | "state">): RuleLowering[] {
  if (rule.state !== "adopted") return [];
  const lowerings: RuleLowering[] = [];

  if (rule.required && rule.level !== "ask") lowerings.push("optional");

  if (rule.level !== "ask") lowerings.push("ask");
  lowerings.push("retire");

  return lowerings;
}

export function minutesLeft(sendAt: number, now: number): number {
  return Math.max(1, Math.ceil((sendAt - now) / 60_000));
}

export type DecidedAction = "cancel" | "undo" | "open" | null;

export interface DecidedState {
  text: string;
  action: DecidedAction;
  actionLabel: string | null;
}

export function decidedState(state: DelegatedView["state"], sendAt: number, now: number): DecidedState {
  switch (state) {
    case "waiting":
      return {
        text: `Sends in ${minutesLeft(sendAt, now)} min`,
        action: "cancel",
        actionLabel: "Cancel",
      };
    case "unconfirmed":
      return { text: "Sending…", action: null, actionLabel: null };
    case "sent":
      return { text: "Answered", action: "undo", actionLabel: "Undo" };
    case "uncertain":
      return { text: "Couldn't confirm it was sent", action: "open", actionLabel: "Open chat" };
    case "cancelled":
      return { text: "Cancelled", action: null, actionLabel: null };
    case "corrected":
      return { text: "Corrected", action: null, actionLabel: null };
  }
}

export interface CompanionStep {
  verdict: Verdict | null;
  failed: boolean;
  labels: string[];
  selected: string[];
  questionId: string;
  revision: number;
}

export interface CompanionInput {
  suggestions: Suggestions;
  agentReady: boolean;
  paused: boolean;
  delegations: readonly ThreadDelegation[];
  steps: readonly CompanionStep[];
  now: number;
}

export type CompanionView =
  | { kind: "hidden" }
  | { kind: "offer" }
  | { kind: "no-agent" }
  | { kind: "reading" }
  | { kind: "suggests"; labels: string[]; reason: string; confidence: string; usable: boolean }
  | { kind: "countdown"; delegation: ThreadDelegation; minutes: number }
  | { kind: "answered"; delegation: ThreadDelegation };

export function companionView(input: CompanionInput): CompanionView {
  if (!input.paused) {
    const waiting = input.delegations.find((item) => item.state === "waiting");

    if (waiting !== undefined)
      return { kind: "countdown", delegation: waiting, minutes: minutesLeft(waiting.sendAt, input.now) };
  }

  const answered = input.delegations.find(
    (item) => item.state === "sent" && input.now - item.updatedAt < ANSWERED_VISIBLE_MS,
  );

  if (answered !== undefined) return { kind: "answered", delegation: answered };

  if (input.steps.length === 0 || input.suggestions === "off") return { kind: "hidden" };

  if (input.suggestions === "undecided") return input.agentReady ? { kind: "offer" } : { kind: "no-agent" };

  if (input.steps.every((step) => step.verdict === null && step.failed)) return { kind: "hidden" };

  if (input.steps.some((step) => step.verdict === null && !step.failed)) return { kind: "reading" };

  const verdicts = input.steps.flatMap((step) => (step.verdict === null ? [] : [step.verdict]));
  const labels = input.steps.flatMap((step) => step.labels);

  if (labels.length === 0) return { kind: "hidden" };

  return {
    kind: "suggests",
    labels,
    reason: verdicts[0]?.reason ?? "",
    confidence: confidenceWord(lowestConfidence(verdicts) ?? "low"),
    usable: input.steps.every(
      (step) =>
        step.selected.length > 0 && step.revision > 0 && step.verdict?.authorityLike !== true,
    ),
  };
}

export type ChiefTab = "decide" | "saved" | "talk" | "rules" | "replies" | "decided";

export type DeckSection = Extract<ChiefTab, "decide" | "rules" | "replies">;

export function sectionFor(card: DeckCardView): DeckSection {
  if (card.ruleOffer) return "rules";

  return card.kind === "result" ? "replies" : "decide";
}

export const TAB_PATH: Record<ChiefTab, string> = {
  decide: "",
  saved: "saved",
  talk: "talk",
  rules: "rules",
  replies: "replies",
  decided: "decided",
};

export function questionFromPath(subPath: string): string | null {
  const [section, id] = subPath.split("/");

  return section === "question" && id ? id : null;
}

export function tabFromPath(subPath: string): ChiefTab {
  const head = subPath.split("/")[0] ?? "";

  return head === "talk" ||
    head === "rules" ||
    head === "replies" ||
    head === "decided" ||
    head === "saved"
    ? head
    : "decide";
}

export function isAssistantTab(tab: ChiefTab): boolean {
  return tab === "talk" || tab === "rules" || tab === "decided";
}

export function visibleTabs(
  view: Pick<DeckView, "tabs" | "savedCards" | "cards"> | null,
  current: ChiefTab,
): ChiefTab[] {
  if (isAssistantTab(current)) {
    const assistant: ChiefTab[] = ["talk", "rules"];

    if (view?.tabs.decided || current === "decided") assistant.push("decided");

    return assistant;
  }

  const inbox: ChiefTab[] = ["decide"];

  if (current === "saved" || (view?.savedCards.length ?? 0) > 0) inbox.push("saved");

  if (current === "replies" || view?.cards.some((card) => sectionFor(card) === "replies"))
    inbox.push("replies");

  return inbox;
}
