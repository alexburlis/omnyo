export function parseUsageCollectorOrigin(
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) return undefined;
  const url = URL.parse(value.trim());

  if (
    !url ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.href !== url.origin + "/"
  ) {
    throw new Error(
      "OMNYO_USAGE_COLLECTOR_URL must be an HTTPS origin or a literal HTTP loopback origin",
    );
  }

  return url.origin;
}
