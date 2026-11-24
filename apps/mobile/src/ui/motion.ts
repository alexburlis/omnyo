import { Easing } from "react-native";

export const MOBILE_MOTION_MS = { fast: 150, base: 250 } as const;

export const MOBILE_EASE_OUT = Easing.bezier(0, 0, 0.58, 1);

export const MOBILE_PRESS_OPACITY = 0.6;
