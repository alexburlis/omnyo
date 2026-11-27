import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { z } from "zod";
import type { badgeSchema } from "../../contract";
import "./style.css";

type Freshness = z.infer<typeof badgeSchema>["freshness"];

export function SentryRailBadge({ count, freshness }: { count: number; freshness: Freshness }) {
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    let current: Element | null = null;

    const attach = () => {
      const next = document.querySelector('[data-nav-rail-item="sentry/sentry"]');

      if (next === current) return;
      current?.classList.remove("sentry-rail-anchor");
      current = next;
      current?.classList.add("sentry-rail-anchor");
      setTarget(current);
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      current?.classList.remove("sentry-rail-anchor");
    };
  }, []);

  if (!target || freshness === "unconfigured") return null;
  const label = (freshness === "live" ? "" : "Last known: ") + count + " open Sentry issues";

  return createPortal(
    <span
      className="sentry-rail-badge"
      data-freshness={freshness}
      title={label}
      role="status"
      aria-label={label}
    >
      {count > 99 ? "99+" : count}
    </span>,
    target,
  );
}
