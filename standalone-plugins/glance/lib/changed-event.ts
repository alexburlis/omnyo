import type { RealtimeCard } from "../contract";

export const CARD_CHANGED_EVENT = "omnyo-glance:changed";

export function announceCardChange(target: EventTarget, change: RealtimeCard): void {
  target.dispatchEvent(new CustomEvent(CARD_CHANGED_EVENT, { detail: change }));
}
