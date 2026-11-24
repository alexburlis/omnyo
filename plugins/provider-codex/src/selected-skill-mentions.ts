interface SkillMentionCandidate {
  start: number;
  end: number;
  resource: {
    kind: string;
    source?: unknown;
    trigger?: unknown;
    name?: unknown;
  };
}

interface SelectedSkillMention extends SkillMentionCandidate {
  resource: {
    kind: "command";
    source: "skill";
    trigger: "/" | "$";
    name: string;
  };
}

export function selectedSkillMentions(input: {
  text: string;
  mentions: readonly SkillMentionCandidate[];
}): SelectedSkillMention[] {
  return input.mentions.filter((mention): mention is SelectedSkillMention => {
    const { start, end, resource } = mention;

    return (
      resource.kind === "command" &&
      resource.source === "skill" &&
      typeof resource.name === "string" &&
      (resource.trigger === "/" || resource.trigger === "$") &&
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      start < end &&
      end <= input.text.length &&
      input.text.slice(start, end) === `${resource.trigger}${resource.name}`
    );
  });
}
