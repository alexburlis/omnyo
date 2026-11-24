import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "prose", "lead", "display", "numeral"],
      shadow: ["control", "control-primary", "card", "card-hover", "lift"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatHomePathForDisplay(pathValue: string): string {
  const homePrefix =
    pathValue.match(/^\/Users\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/home\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/root(?=\/|$)/)?.[0] ??
    pathValue.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i)?.[0];

  return homePrefix === undefined
    ? pathValue
    : `~${pathValue.slice(homePrefix.length)}`;
}
