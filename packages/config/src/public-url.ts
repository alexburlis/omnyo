export function validateOptionalUrl(name: string, value: string): string {
  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    return "";
  }

  return validateRequiredUrl(name, trimmedValue);
}

export function validateRequiredUrl(name: string, value: string): string {
  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  try {
    void new URL(trimmedValue);

    return trimmedValue;
  } catch {
    throw new Error(`${name} must be a valid URL, received "${value}"`);
  }
}

function parseAppAliasOrigin(name: string, entry: string): string {
  const invalid = (reason: string) =>
    new Error(
      `${name} entries must be absolute https origins such as https://app.example.com; "${entry}" ${reason}`,
    );

  if (entry.length === 0) {
    throw invalid("is empty");
  }

  if (entry.includes("*")) {
    throw invalid("contains a wildcard");
  }

  let url: URL;

  try {
    url = new URL(entry);
  } catch {
    throw invalid("is not a valid URL");
  }

  if (url.protocol !== "https:") {
    throw invalid("does not use https");
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw invalid("contains credentials");
  }

  if (
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !/^https:\/\/[^/?#]+\/?$/iu.test(entry)
  ) {
    throw invalid("contains a path, query or fragment");
  }

  return url.origin;
}

export function parseAppAliasOrigins(name: string, value: string): string[] {
  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    return [];
  }

  return [
    ...new Set(
      trimmedValue
        .split(",")
        .map((entry) => parseAppAliasOrigin(name, entry.trim())),
    ),
  ];
}
