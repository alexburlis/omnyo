const windowsDrivePath = /^([A-Za-z]):(?:[\\/]+|$)/u;

const windowsUncPath = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/u;

const windowsSeparator = /[\\/]+/u;

function collapse(rawSegments: string[]): string[] {
  const segments: string[] = [];

  for (const segment of rawSegments) {
    if (segment.length === 0 || segment === ".") continue;

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments;
}

function windowsKey(root: string, rest: string): string {
  const segments = collapse(rest.split(windowsSeparator)).map((segment) =>
    segment.toLowerCase(),
  );

  return segments.length === 0 ? root : `${root}${segments.join("\\")}`;
}

export function hostPathComparisonKey(path: string): string | null {
  const drive = windowsDrivePath.exec(path);

  if (drive)
    return windowsKey(
      `${(drive[1] ?? "").toLowerCase()}:\\`,
      path.slice(drive[0].length),
    );

  const unc = windowsUncPath.exec(path);

  if (unc)
    return windowsKey(
      `\\\\${unc[1] ?? ""}\\${unc[2] ?? ""}\\`.toLowerCase(),
      path.slice(unc[0].length),
    );

  return path.startsWith("/")
    ? `/${collapse(path.split("/")).join("/")}`
    : null;
}
