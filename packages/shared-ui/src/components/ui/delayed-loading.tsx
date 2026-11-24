import {
  Fragment,
  isValidElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Slot } from "@radix-ui/react-slot";

const LOADING_REVEAL_DELAY_MS = 200;

const LOADING_REVEAL_MOTION_CLASS =
  "animate-in fade-in-0 duration-(--motion-duration-fast)";

export function DelayedLoading({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setVisible(true),
      LOADING_REVEAL_DELAY_MS,
    );

    return () => window.clearTimeout(timeout);
  }, []);

  if (!visible) return null;

  return isValidElement(children) && children.type !== Fragment ? (
    <Slot className={LOADING_REVEAL_MOTION_CLASS}>{children}</Slot>
  ) : (
    children
  );
}
