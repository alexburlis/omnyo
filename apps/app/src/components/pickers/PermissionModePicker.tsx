import { useMemo, type ReactElement } from "react";
import type { PermissionMode } from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import { COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PERMISSION_MODE_ICONS } from "@/lib/permission-mode-options";
import { OptionPicker, type PickerOption } from "./OptionPicker";

type PermissionModeOption = PickerOption<PermissionMode>;

const APPROVALS_LABEL = "Approvals";

const DISPLAY_OVERRIDE_ICON: IconName = "ListTodo";

function getPermissionModeCompactLabel(value: PermissionMode): string {
  switch (value) {
    case "full":
      return "Full";
    case "accept-edits":
      return "Edits";
    case "auto":
      return "Auto";
  }
}

function addPermissionModeCompactLabels(
  options: readonly PermissionModeOption[],
): PermissionModeOption[] {
  return options.map((option) => ({
    ...option,
    compactLabel:
      option.compactLabel ?? getPermissionModeCompactLabel(option.value),
    menuIconName: option.menuIconName ?? PERMISSION_MODE_ICONS[option.value],
  }));
}

export interface PermissionModePickerProps {
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
  className?: string;
  muted?: boolean;
  defaultOpen?: boolean;
  modal?: boolean;
  align?: "start" | "center" | "end";
  displayOverride?: {
    label: string;
    compactLabel?: string;
    description?: string;
    title?: string;
  };
  disabled?: boolean;
  showChevronWhenDisabled?: boolean;
  showWhenSingleOption?: boolean;
  presentation?: "label" | "icon";
}

export function PermissionModePicker({
  value,
  options,
  onChange,
  supported,
  className,
  muted = true,
  defaultOpen,
  modal,
  align = "end",
  displayOverride,
  disabled,
  showChevronWhenDisabled,
  showWhenSingleOption = false,
  presentation = "label",
}: PermissionModePickerProps) {
  const compactOptions = useMemo(
    () => addPermissionModeCompactLabels(options),
    [options],
  );

  if (
    !supported ||
    value === undefined ||
    (!showWhenSingleOption && options.length <= 1)
  ) {
    return null;
  }

  const pickerDisabled = disabled || options.length <= 1;

  return (
    <OptionPicker
      label={presentation === "icon" ? APPROVALS_LABEL : "Permission mode"}
      value={value}
      options={compactOptions}
      onChange={onChange}
      className={className}
      caretClassName="text-subtle-foreground/75"
      contentClassName="max-w-72"
      muted={muted}
      defaultOpen={defaultOpen}
      modal={modal}
      align={align}
      displayOverride={displayOverride}
      disabled={pickerDisabled}
      showChevronWhenDisabled={showChevronWhenDisabled}
      trigger={
        presentation === "icon"
          ? permissionModeIconTrigger({
              value,
              options,
              displayOverride,
              disabled: pickerDisabled,
              className,
            })
          : undefined
      }
    />
  );
}

interface PermissionModeIconTriggerArgs extends Pick<
  PermissionModePickerProps,
  "options" | "displayOverride" | "className"
> {
  value: PermissionMode;
  disabled: boolean;
}

function permissionModeIconTrigger({
  value,
  options,
  displayOverride,
  disabled,
  className,
}: PermissionModeIconTriggerArgs): ReactElement {
  const selectedOption = options.find((option) => option.value === value);
  const label = displayOverride?.label ?? selectedOption?.label ?? value;

  const description =
    displayOverride?.description ?? selectedOption?.description;

  const isWarning = !displayOverride && selectedOption?.tone === "warning";

  const title =
    displayOverride?.title ??
    (description
      ? `${APPROVALS_LABEL}: ${label} - ${description}`
      : `${APPROVALS_LABEL}: ${label}`);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`${APPROVALS_LABEL}: ${label}`}
      disabled={disabled}
      className={cn(
        COARSE_POINTER_PROMPT_ICON_ACTION_BUTTON_CLASS,
        className,
        isWarning &&
          "text-warning-text hover:text-warning-text data-[state=open]:text-warning-text",
        disabled && "cursor-default disabled:opacity-100",
      )}
    >
      <span
        className="flex size-full items-center justify-center"
        title={title}
      >
        <Icon
          name={
            displayOverride
              ? DISPLAY_OVERRIDE_ICON
              : PERMISSION_MODE_ICONS[value]
          }
          className="size-4"
          aria-hidden
        />
      </span>
    </Button>
  );
}
