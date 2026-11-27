export function chatTapOptions(split = false) {
  return { split, experimental_userInitiated: true } as const;
}
