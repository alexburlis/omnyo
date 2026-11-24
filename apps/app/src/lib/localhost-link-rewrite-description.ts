export function localhostLinkRewriteDescription(
  currentHostname: string | undefined,
): string | null {
  return currentHostname === undefined
    ? null
    : "Open managed previews on localhost on their computer, or through private Omnyo access on another device.";
}
