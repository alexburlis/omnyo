export const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+private\.(\d+))?$/u;

export function parseReleaseVersion(value) {
  if (typeof value !== "string") {
    return null;
  }

  const match = RELEASE_VERSION_PATTERN.exec(value);

  if (match === null) {
    return null;
  }

  return {
    numeric: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    revision: match[4] === undefined ? null : Number(match[4]),
  };
}

function requireReleaseVersion(value) {
  const parsed = parseReleaseVersion(value);

  if (parsed === null) {
    throw new Error(`Invalid Omnyo release version: ${String(value)}`);
  }

  return parsed;
}

function compareNumbers(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareReleaseNumbers(left, right) {
  const a = requireReleaseVersion(left);
  const b = requireReleaseVersion(right);

  return (
    compareNumbers(a.major, b.major) ||
    compareNumbers(a.minor, b.minor) ||
    compareNumbers(a.patch, b.patch)
  );
}

export function compareReleaseVersions(left, right) {
  const numeric = compareReleaseNumbers(left, right);

  if (numeric !== 0) {
    return numeric;
  }

  const a = requireReleaseVersion(left).revision;
  const b = requireReleaseVersion(right).revision;

  if (a === b) {
    return 0;
  }

  if (a === null) {
    return -1;
  }

  if (b === null) {
    return 1;
  }

  return compareNumbers(a, b);
}

export function macBundleVersion(version) {
  const parsed = requireReleaseVersion(version);

  return parsed.revision === null ? parsed.numeric : String(parsed.revision);
}
