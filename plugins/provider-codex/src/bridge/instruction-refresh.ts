import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export type InstructionSectionDigests = Readonly<Record<string, string>>;

interface InstructionSection {
  key: string;
  text: string;
}

const SECTION_HEADER_PATTERN =
  /(?<=^|\n\n)The following (?:\w+ )?instructions come from [^\n]+:(?=\n\n|$)/gu;

const OPENING_SECTION_KEY = "";

const UNKNOWN_CONTEXT_INTRO =
  "Omnyo's current instructions for this chat follow. They replace every earlier Omnyo instruction block in this conversation.";

const CHANGED_CONTEXT_INTRO =
  "Omnyo updated this chat's instructions. Each section below replaces the earlier section that starts with the same line, and its rules apply from now on. Earlier Omnyo sections not listed here still apply.";

const OPENING_SECTION_LABEL =
  "Omnyo's opening chat instructions now read as follows, replacing the earlier untitled opening section:";

const OPENING_SECTION_NAME = "Omnyo's untitled opening chat instructions";

const storedContextSchema = z.object({
  version: z.literal(1),
  sections: z.record(z.string(), z.string()),
});

function splitInstructionSections(instructions: string): InstructionSection[] {
  const text = instructions.trim();
  const headers = [...text.matchAll(SECTION_HEADER_PATTERN)];
  const sections: InstructionSection[] = [];
  const opening = text.slice(0, headers[0]?.index ?? text.length).trim();

  if (opening.length > 0) {
    sections.push({ key: OPENING_SECTION_KEY, text: opening });
  }

  const occurrences = new Map<string, number>();

  for (const [index, header] of headers.entries()) {
    const end = headers[index + 1]?.index ?? text.length;
    const count = (occurrences.get(header[0]) ?? 0) + 1;
    occurrences.set(header[0], count);
    sections.push({
      key: count === 1 ? header[0] : `${header[0]} (${count})`,
      text: text.slice(header.index, end).trim(),
    });
  }

  return sections;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function digestInstructionSections(
  instructions: string | undefined,
): InstructionSectionDigests {
  return Object.fromEntries(
    splitInstructionSections(instructions ?? "").map((section) => [
      section.key,
      digest(section.text),
    ]),
  );
}

export function sameInstructionSections(
  left: InstructionSectionDigests,
  right: InstructionSectionDigests,
): boolean {
  const leftKeys = Object.keys(left);

  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

export function instructionRefreshMessage(
  inContext: InstructionSectionDigests | null,
  instructions: string | undefined,
): string | null {
  const sections = splitInstructionSections(instructions ?? "");
  const currentKeys = new Set(sections.map((section) => section.key));

  const changed = sections.filter(
    (section) => inContext?.[section.key] !== digest(section.text),
  );

  const removed =
    inContext === null
      ? []
      : Object.keys(inContext).filter((key) => !currentKeys.has(key));

  if (changed.length === 0 && removed.length === 0) {
    return null;
  }

  const parts = [
    inContext === null ? UNKNOWN_CONTEXT_INTRO : CHANGED_CONTEXT_INTRO,
  ];

  for (const section of changed) {
    parts.push(
      section.key === OPENING_SECTION_KEY
        ? `${OPENING_SECTION_LABEL}\n\n${section.text}`
        : section.text,
    );
  }

  if (removed.length > 0) {
    parts.push(
      [
        "These earlier Omnyo sections no longer apply:",
        ...removed.map(
          (key) =>
            `- ${key === OPENING_SECTION_KEY ? OPENING_SECTION_NAME : key}`,
        ),
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}

export class InstructionContextStore {
  readonly #directory: string;

  readonly #writes = new Map<string, Promise<void>>();

  constructor(directory: string) {
    this.#directory = directory;
  }

  #path(codexThreadId: string): string {
    return join(this.#directory, `${digest(codexThreadId)}.json`);
  }

  async read(codexThreadId: string): Promise<InstructionSectionDigests | null> {
    let raw: string;

    try {
      raw = await readFile(this.#path(codexThreadId), "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }

      throw error;
    }

    return storedContextSchema.parse(JSON.parse(raw)).sections;
  }

  write(
    codexThreadId: string,
    sections: InstructionSectionDigests,
  ): Promise<void> {
    const previous = this.#writes.get(codexThreadId) ?? Promise.resolve();

    const next = previous
      .catch(() => undefined)
      .then(() => this.#writeNow(codexThreadId, sections));

    const settle = () => {
      if (this.#writes.get(codexThreadId) === next) {
        this.#writes.delete(codexThreadId);
      }
    };

    this.#writes.set(codexThreadId, next);
    next.then(settle, settle);

    return next;
  }

  async #writeNow(
    codexThreadId: string,
    sections: InstructionSectionDigests,
  ): Promise<void> {
    const path = this.#path(codexThreadId);
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(this.#directory, { recursive: true });
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, sections }),
      "utf8",
    );
    await rename(temporary, path);
  }
}
