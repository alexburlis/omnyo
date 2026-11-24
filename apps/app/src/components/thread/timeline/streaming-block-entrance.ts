import { useLayoutEffect, useRef, type RefObject } from "react";

export const STREAMING_BLOCK_ENTRANCE_ATTRIBUTE = "data-streaming-block-enter";

const STREAMING_BLOCK_ENTRANCE_ANIMATION = "omnyo-streaming-block-enter";

const MARKDOWN_PREVIEW_SELECTOR = "[data-markdown-preview]";

function markBlockEntering(block: HTMLElement): void {
  const finish = (event: AnimationEvent) => {
    if (
      event.target !== block ||
      event.animationName !== STREAMING_BLOCK_ENTRANCE_ANIMATION
    ) {
      return;
    }

    block.removeAttribute(STREAMING_BLOCK_ENTRANCE_ATTRIBUTE);
    block.removeEventListener("animationend", finish);
    block.removeEventListener("animationcancel", finish);
  };

  block.addEventListener("animationend", finish);
  block.addEventListener("animationcancel", finish);
  block.setAttribute(STREAMING_BLOCK_ENTRANCE_ATTRIBUTE, "");
}

function findMessagePreviews(container: HTMLElement): HTMLElement[] {
  const first = container.querySelector<HTMLElement>(MARKDOWN_PREVIEW_SELECTOR);

  if (first === null) return [];
  const previews = [first];
  let sibling = first.nextElementSibling;

  while (sibling !== null) {
    if (
      sibling instanceof HTMLElement &&
      sibling.matches(MARKDOWN_PREVIEW_SELECTOR)
    ) {
      previews.push(sibling);
    }

    sibling = sibling.nextElementSibling;
  }

  return previews;
}

function markNewestBlocks(
  previews: readonly HTMLElement[],
  count: number,
): void {
  let remaining = count;

  for (let index = previews.length - 1; index >= 0 && remaining > 0; index--) {
    let block = previews[index]!.lastElementChild;

    while (block !== null && remaining > 0) {
      if (block instanceof HTMLElement) markBlockEntering(block);
      remaining -= 1;
      block = block.previousElementSibling;
    }
  }
}

export function useStreamingBlockEntrance(
  containerRef: RefObject<HTMLElement | null>,
  streaming: boolean,
): void {
  const maxBlockCountRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;

    if (!streaming || container === null) {
      maxBlockCountRef.current = null;

      return;
    }

    const previews = findMessagePreviews(container);

    const blockCount = previews.reduce(
      (total, preview) => total + preview.childElementCount,
      0,
    );

    const maxBlockCount = maxBlockCountRef.current;

    if (maxBlockCount !== null && blockCount > maxBlockCount) {
      markNewestBlocks(previews, blockCount - maxBlockCount);
    }

    maxBlockCountRef.current =
      maxBlockCount === null ? blockCount : Math.max(maxBlockCount, blockCount);
  });
}
