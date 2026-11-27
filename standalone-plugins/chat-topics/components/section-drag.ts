import { useCallback, useState } from "react";
import type { DragEvent } from "react";
import type { DropPlace, InboxSectionKey } from "../lib/inbox-order.ts";

interface Drop {
  key: InboxSectionKey;
  place: DropPlace;
}

function placeOf(event: DragEvent<HTMLElement>): DropPlace {
  const box = event.currentTarget.getBoundingClientRect();

  return event.clientY < box.top + box.height / 2 ? "before" : "after";
}

export function useSectionDrag(
  enabled: boolean,
  move: (moved: InboxSectionKey, target: InboxSectionKey, place: DropPlace) => void,
) {
  const [dragging, setDragging] = useState<InboxSectionKey | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const end = useCallback(() => {
    setDragging(null);
    setDrop(null);
  }, []);

  const heading = (key: InboxSectionKey, label: string) =>
    enabled
      ? {
          draggable: true,
          title: `Drag to move ${label}`,
          "data-dragging": dragging === key ? "" : undefined,
          onDragStart: (event: DragEvent<HTMLElement>) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", label);
            setDragging(key);
          },
          onDragEnd: end,
        }
      : {};

  const section = (key: InboxSectionKey) =>
    dragging === null
      ? {}
      : {
          "data-drop": drop?.key === key && dragging !== key ? drop.place : undefined,
          onDragOver: (event: DragEvent<HTMLElement>) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const place = placeOf(event);

            if (drop?.key !== key || drop.place !== place) setDrop({ key, place });
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            event.preventDefault();
            move(dragging, key, placeOf(event));
            end();
          },
        };

  return { heading, section };
}
