import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import Globe02Icon from "@hugeicons/core-free-icons/Globe02Icon";
import PackageIcon from "@hugeicons/core-free-icons/PackageIcon";
import QuillWrite01Icon from "@hugeicons/core-free-icons/QuillWrite01Icon";
import WorkflowSquare01Icon from "@hugeicons/core-free-icons/WorkflowSquare01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { copyPlainText } from "../lib/copy-plain-text";
import {
  EXPLORE_KIND_LABELS,
  canonicalExploreUrl,
  type ExploreItem,
  type ExploreKind,
  type ExploreLink,
} from "./catalog";

const KIND_ICONS = {
  prompt: QuillWrite01Icon,
  workflow: WorkflowSquare01Icon,
  skill: PackageIcon,
  plugin: Globe02Icon,
  guide: BookOpen01Icon,
} satisfies Record<ExploreKind, unknown>;

export function KindIcon({
  kind,
  className,
}: {
  kind: ExploreKind;
  className?: string;
}) {
  return (
    <HugeiconsIcon icon={KIND_ICONS[kind]} className={className} aria-hidden />
  );
}

interface CopyState {
  message: string;
  fallbackUrl: string | null;
}

export function useCopyStatus() {
  const [status, setStatus] = useState<CopyState | null>(null);

  async function copy({
    text,
    copied,
    failed,
    fallbackUrl = null,
  }: {
    text: string;
    copied: string;
    failed: string;
    fallbackUrl?: string | null;
  }) {
    const ok = await copyPlainText(text);

    setStatus(
      ok
        ? { message: copied, fallbackUrl: null }
        : { message: failed, fallbackUrl },
    );
  }

  return { status, copy };
}

export function CopyStatus({ status }: { status: CopyState | null }) {
  return (
    <div className="ex-status-row">
      <p className="ex-status" role="status">
        {status?.message ?? ""}
      </p>
      {status?.fallbackUrl ? (
        <a className="ex-canonical" href={status.fallbackUrl}>
          {status.fallbackUrl}
        </a>
      ) : null}
    </div>
  );
}

export function canonicalItemUrl(item: Pick<ExploreItem, "path">) {
  return canonicalExploreUrl(item.path);
}

export function itemByline(item: Pick<ExploreItem, "kind" | "publisher">) {
  const byline = `${EXPLORE_KIND_LABELS[item.kind].one} · By ${item.publisher}`;

  return item.kind === "plugin" ? `${byline} · Omnyo Official` : byline;
}

export function RelatedLinks({
  links,
  headingClassName,
}: {
  links: readonly ExploreLink[];
  headingClassName?: string;
}) {
  if (!links.length) return null;

  return (
    <section className="ex-related" aria-labelledby="ex-related-heading">
      <h2 id="ex-related-heading" className={headingClassName}>
        Next steps
      </h2>
      <ul>
        {links.map((link) => (
          <li key={link.path}>
            <a href={link.path}>
              <KindIcon kind={link.kind} className="ex-related-icon" />
              <span>
                <span className="ex-related-kind">
                  {EXPLORE_KIND_LABELS[link.kind].one}
                </span>
                {link.title}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
