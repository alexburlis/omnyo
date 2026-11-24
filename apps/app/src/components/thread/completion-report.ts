export function removeCompletionReportFromDisplay({
  text,
  assessmentReason,
}: {
  text: string;
  assessmentReason: string;
}): string {
  const report = assessmentReason.replace(/ \(not model-checked\)$/u, "");

  if (!/^Completed: .+; verified: .+$/u.test(report)) return text;

  const lines = text.split("\n");
  let fence: string | null = null;
  const matches: number[] = [];

  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);

    if (marker) {
      const delimiter = marker[1];

      if (fence === null) fence = delimiter;
      else if (
        delimiter[0] === fence[0] &&
        delimiter.length >= fence.length &&
        marker[2].trim() === ""
      )
        fence = null;
      continue;
    }

    if (fence === null && line === report) matches.push(index);
  }

  if (matches.length !== 1) return text;

  return lines
    .filter((_, index) => index !== matches[0])
    .join("\n")
    .trimEnd();
}
