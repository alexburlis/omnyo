import { Button, type ButtonProps } from "@omnyo/shared-ui/button";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { Icon } from "@omnyo/shared-ui/icon";

export default {
  title: "ui/Button",
};

type ButtonVariant = NonNullable<ButtonProps["variant"]>;

type ButtonSize = NonNullable<ButtonProps["size"]>;

const variants: readonly ButtonVariant[] = [
  "default",
  "secondary",
  "outline",
  "soft",
  "ghost",
  "destructive",
  "link",
];

const sizes: readonly ButtonSize[] = ["xs", "sm", "default", "lg", "icon"];

const VARIANT_LABEL: Record<ButtonVariant, string> = {
  default: "Save changes",
  secondary: "Cancel",
  outline: "Connect repo",
  soft: "Restart",
  ghost: "Settings",
  destructive: "Delete project",
  link: "View docs",
};

export function Overview() {
  return (
    <>
      <StoryCard columns={sizes}>
        {variants.map((variant) => (
          <StoryRow key={variant} label={variant}>
            {sizes.map((size) => (
              <Button
                key={size}
                variant={variant}
                size={size}
                aria-label={
                  size === "icon" ? VARIANT_LABEL[variant] : undefined
                }
              >
                {size === "icon" ? (
                  <Icon name="Plus" />
                ) : (
                  VARIANT_LABEL[variant]
                )}
              </Button>
            ))}
          </StoryRow>
        ))}
      </StoryCard>
      <StoryCard>
        <StoryRow label="with icons">
          <Button>
            <Icon name="Check" />
            Save changes
          </Button>
          <Button variant="outline" size="sm">
            Add local path
            <Icon name="ArrowRight" />
          </Button>
        </StoryRow>
        <StoryRow label="disabled">
          {variants.map((variant) => (
            <Button key={variant} variant={variant} disabled>
              {variant}
            </Button>
          ))}
        </StoryRow>
      </StoryCard>
    </>
  );
}

export function RowActions() {
  return (
    <StoryCard>
      <StoryRow
        label="inline row actions"
        hint="xs + soft for actions that live inside a list row"
      >
        <div className="flex w-full max-w-xl items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-card">
          <span className="size-2 shrink-0 rounded-full bg-success ring-[3px] ring-success/20" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            localhost:61424
          </span>
          <Button size="xs" variant="soft">
            <Icon name="ExternalLink" />
            Open
          </Button>
          <Button size="xs" variant="ghost">
            Stop
          </Button>
        </div>
      </StoryRow>
      <StoryRow label="icon-xs" hint="compact icon actions with a label">
        <Button size="icon-xs" variant="ghost" aria-label="Remove file">
          <Icon name="X" />
        </Button>
        <Button size="icon-xs" variant="soft" aria-label="More actions">
          <Icon name="MoreHorizontal" />
        </Button>
        <Button size="icon-sm" variant="outline" aria-label="Add">
          <Icon name="Plus" />
        </Button>
      </StoryRow>
      <StoryRow label="hierarchy" hint="one primary, quieter alternatives">
        <Button>Save disabled copy</Button>
        <Button variant="outline">Preview</Button>
        <Button variant="ghost">Cancel</Button>
      </StoryRow>
    </StoryCard>
  );
}
