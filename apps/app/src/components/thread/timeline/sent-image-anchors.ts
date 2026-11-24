import { useCallback, useEffect, useRef, useState } from "react";
import {
  isPromptImageAnchorMention,
  promptImageAliasNumber,
} from "@omnyo/client-core";
import {
  promptMentionResourceSchema,
  type PromptTextMention,
} from "@omnyo/domain";

export const IMAGE_ANCHOR_ATTR = "data-image-anchor";

export const IMAGE_ANCHOR_ACTIVE_ATTR = "data-image-anchor-active";

const MENTION_RESOURCE_ATTR = "data-prompt-mention-resource";

export function pairSentImageAnchors({
  text,
  mentions,
  localImagePaths,
}: {
  text: string;
  mentions: readonly PromptTextMention[];
  localImagePaths: readonly string[];
}): (string | null)[] {
  const anchors: { label: string; path: string }[] = [];
  const seen = new Set<string>();

  for (const mention of [...mentions].sort(
    (left, right) => left.start - right.start,
  )) {
    if (
      mention.resource.kind !== "attachment" ||
      !isPromptImageAnchorMention(mention, text)
    ) {
      continue;
    }

    const key = `${mention.resource.label}\0${mention.resource.path}`;

    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push({
      label: mention.resource.label,
      path: mention.resource.path,
    });
  }

  const labels: (string | null)[] = localImagePaths.map(() => null);

  for (const [index, anchor] of anchors.entries()) {
    if (localImagePaths[index] !== anchor.path) break;
    labels[index] = anchor.label;
  }

  return labels;
}

export function imageAnchorLabelFromElement(element: Element): string | null {
  const labelled = element.closest(`[${IMAGE_ANCHOR_ATTR}]`);
  const direct = labelled?.getAttribute(IMAGE_ANCHOR_ATTR);

  if (direct) return direct;

  const raw = element
    .closest(`[${MENTION_RESOURCE_ATTR}]`)
    ?.getAttribute(MENTION_RESOURCE_ATTR);

  if (!raw) return null;

  try {
    const resource = promptMentionResourceSchema.safeParse(JSON.parse(raw));

    return resource.success &&
      resource.data.kind === "attachment" &&
      promptImageAliasNumber(resource.data.label) !== null
      ? resource.data.label
      : null;
  } catch {
    return null;
  }
}

export function useSentImageAnchorHighlight(enabled: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) return;

    for (const element of container.querySelectorAll(
      `[${IMAGE_ANCHOR_ACTIVE_ATTR}]`,
    ))
      element.removeAttribute(IMAGE_ANCHOR_ACTIVE_ATTR);

    if (activeLabel === null) return;

    for (const element of container.querySelectorAll(
      `[${IMAGE_ANCHOR_ATTR}], [${MENTION_RESOURCE_ATTR}]`,
    )) {
      if (imageAnchorLabelFromElement(element) === activeLabel)
        element.setAttribute(IMAGE_ANCHOR_ACTIVE_ATTR, "true");
    }
  }, [activeLabel]);

  const track = useCallback(
    (target: EventTarget | null) => {
      if (!enabled) return;

      setActiveLabel(
        target instanceof Element ? imageAnchorLabelFromElement(target) : null,
      );
    },
    [enabled],
  );

  return {
    containerRef,
    handlers: {
      onPointerOver: (event: { target: EventTarget | null }) =>
        track(event.target),
      onPointerLeave: () => track(null),
      onFocus: (event: { target: EventTarget | null }) => track(event.target),
      onBlur: () => track(null),
    },
  };
}
