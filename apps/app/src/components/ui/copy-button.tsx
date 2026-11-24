import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { useClipboardCopy, type ClipboardCopyOptions } from "@/lib/clipboard";
import { HOVER_REVEAL_NO_HOVER_VISIBLE_CLASS } from "@omnyo/shared-ui/hover-reveal";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Icon } from "@omnyo/shared-ui/icon";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";

const COPY_GLYPH_CLASS =
  "col-start-1 row-start-1 size-3 transition-[opacity,scale] motion-reduce:scale-100";

export function CopyGlyph({
  copied,
  className,
  iconClassName,
}: {
  copied: boolean;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid place-items-center", className)}
    >
      <Icon
        name="Copy"
        className={cn(
          COPY_GLYPH_CLASS,
          copied
            ? "scale-90 opacity-0 duration-(--motion-duration-fast)"
            : "scale-100 opacity-100 duration-(--motion-duration-base) ease-(--motion-ease-snappy)",
          iconClassName,
        )}
      />
      <Icon
        name="Check"
        className={cn(
          COPY_GLYPH_CLASS,
          copied
            ? "scale-100 opacity-100 duration-(--motion-duration-base) ease-(--motion-ease-snappy)"
            : "scale-90 opacity-0 duration-(--motion-duration-fast)",
          iconClassName,
        )}
      />
    </span>
  );
}

interface CopyButtonProps
  extends
    ClipboardCopyOptions,
    Omit<ComponentPropsWithoutRef<"button">, "type" | "onClick" | "title"> {
  iconClassName?: string;
  label?: string;
}

export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(
  function CopyButton(
    {
      text,
      className,
      iconClassName,
      label = "Copy to clipboard",
      successMessage,
      errorMessage,
      imageUrl,
      ...rest
    },
    ref,
  ) {
    const { copied, copy } = useClipboardCopy({
      text,
      successMessage,
      errorMessage,
      imageUrl,
    });

    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        {...rest}
        className={cn(
          `inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground ${CONTROL_HOVER_TRANSITION} hover:text-foreground focus-visible:opacity-100`,
          className,
        )}
        onClick={() => {
          void copy();
        }}
      >
        <CopyGlyph copied={copied} iconClassName={iconClassName} />
      </button>
    );
  },
);

interface CopyableInlineLabelProps extends ClipboardCopyOptions {
  label: string;
  title?: string;
  children?: ReactNode;
}

export function CopyableInlineLabel({
  text,
  label,
  title,
  successMessage,
  errorMessage,
  children,
}: CopyableInlineLabelProps) {
  const { copied, copy } = useClipboardCopy({
    text,
    successMessage,
    errorMessage,
  });

  return (
    <button
      type="button"
      className={`group/copy inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md text-left text-foreground ${CONTROL_HOVER_TRANSITION} hover:text-foreground/80`}
      onClick={() => {
        void copy();
      }}
      aria-label={label}
    >
      <span className="min-w-0 truncate" title={title ?? text}>
        {children ?? text}
      </span>
      <CopyGlyph
        copied={copied}
        className={cn(
          "shrink-0 text-subtle-foreground transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
          HOVER_REVEAL_NO_HOVER_VISIBLE_CLASS,
          copied ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}
