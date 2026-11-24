import { FOCUS_RING_CLASS } from "@omnyo/shared-ui/focus-ring";
import {
  CONTROL_HOVER_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";

const ROW_ACTION_BASE = `inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border-0 px-2 text-2xs leading-none font-medium disabled:cursor-default disabled:opacity-50 pointer-coarse:h-8 pointer-coarse:px-3 ${FOCUS_RING_CLASS}`;

export const ROW_ACTION_CLASS = `${ROW_ACTION_BASE} bg-state-hover text-sidebar-foreground hover:bg-state-active ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK}`;

export const ROW_PRIMARY_ACTION_CLASS = `${ROW_ACTION_BASE} bg-control-primary text-control-primary-foreground shadow-control-primary hover:bg-control-primary-hover ${CONTROL_PRESS_TRANSITION} ${CONTROL_PRESS_FEEDBACK}`;

export const ROW_QUIET_ACTION_CLASS = `${ROW_ACTION_BASE} bg-transparent px-1.5 font-normal text-muted-foreground hover:bg-state-hover hover:text-sidebar-foreground ${CONTROL_HOVER_TRANSITION}`;
