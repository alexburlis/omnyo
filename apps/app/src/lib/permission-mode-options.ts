import type { PermissionMode } from "@omnyo/domain";
import type { IconName } from "@omnyo/shared-ui/icon";
import {
  PERMISSION_MODE_OPTIONS as CORE_PERMISSION_MODE_OPTIONS,
  type PermissionModeOption as CorePermissionModeOption,
} from "@omnyo/client-core";

export interface PermissionModeOption extends CorePermissionModeOption {
  iconName: IconName;
}

export const PERMISSION_MODE_ICONS: Record<PermissionMode, IconName> = {
  "accept-edits": "ShieldUser",
  auto: "ShieldCheck",
  full: "ShieldOff",
};

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] =
  CORE_PERMISSION_MODE_OPTIONS.map((option) => ({
    ...option,
    iconName: PERMISSION_MODE_ICONS[option.value],
  }));
