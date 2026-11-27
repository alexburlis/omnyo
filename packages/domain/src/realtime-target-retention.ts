import {
  realtimeSubscriptionTargetKey,
  type RealtimeSubscriptionTarget,
} from "./change-kinds.js";

export class RealtimeTargetRetention {
  private readonly targets = new Map<
    string,
    { count: number; target: RealtimeSubscriptionTarget }
  >();

  retain(target: RealtimeSubscriptionTarget): boolean {
    const key = realtimeSubscriptionTargetKey(target);
    const existing = this.targets.get(key);

    if (existing) {
      existing.count += 1;

      return false;
    }

    this.targets.set(key, { count: 1, target });

    return true;
  }

  release(target: RealtimeSubscriptionTarget): boolean {
    const key = realtimeSubscriptionTargetKey(target);
    const existing = this.targets.get(key);

    if (!existing) return false;

    if (existing.count > 1) {
      existing.count -= 1;

      return false;
    }

    this.targets.delete(key);

    return true;
  }

  *values(): IterableIterator<RealtimeSubscriptionTarget> {
    for (const { target } of this.targets.values()) yield target;
  }

  get size(): number {
    return this.targets.size;
  }

  clear(): void {
    this.targets.clear();
  }
}
