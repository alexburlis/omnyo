import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as Markdown from "./streaming-markdown-split";

it.skipIf(!process.env.OMNYO_MARKDOWN_MEASUREMENT_OUTPUT)(
  "measures fixed streaming workloads",
  () => {
    const prefix = "Completed paragraph with ordinary words.\n\n".repeat(3000);

    const plain =
      "Plain prose without formatting markers or unfinished constructs. ".repeat(
        2100,
      );

    const cases = [
      { name: "settled-history", initial: `${prefix}Current answer.\n` },
      {
        name: "open-paragraph",
        initial: "Long unbroken paragraph of plain prose. ".repeat(3500),
      },
    ];

    const results: {
      name: string;
      inputHash: string;
      bytes: number;
      samplesMs: number[];
    }[] = [];

    for (const item of cases) {
      const samplesMs: number[] = [];

      for (let run = 0; run < 35; run++) {
        const split =
          Markdown.createStreamingMarkdownSplitter?.() ??
          Markdown.splitStreamingMarkdown;

        let content = item.initial;
        split(content);
        const start = performance.now();

        for (let step = 0; step < 40; step++) {
          content += ` append ${step}.\n`;
          split(content);
        }

        const duration = performance.now() - start;

        if (run >= 5) samplesMs.push(duration / 40);
        expect(split(content)).toEqual(
          Markdown.splitStreamingMarkdown(content),
        );
      }

      results.push({
        name: item.name,
        inputHash: createHash("sha256").update(item.initial).digest("hex"),
        bytes: Buffer.byteLength(item.initial),
        samplesMs,
      });
    }

    const samplesMs: number[] = [];

    for (let run = 0; run < 35; run++) {
      const start = performance.now();

      for (let step = 0; step < 40; step++)
        Markdown.repairStreamingMarkdownTail(`${plain}${step} `);

      if (run >= 5) samplesMs.push((performance.now() - start) / 40);
    }

    expect(Markdown.repairStreamingMarkdownTail(`${plain}finished `)).toBe(
      `${plain}finished`,
    );
    results.push({
      name: "plain-tail-repair",
      inputHash: createHash("sha256").update(plain).digest("hex"),
      bytes: Buffer.byteLength(plain),
      samplesMs,
    });
    writeFileSync(
      process.env.OMNYO_MARKDOWN_MEASUREMENT_OUTPUT!,
      JSON.stringify({ results, completed: true }, null, 2),
    );
  },
);
