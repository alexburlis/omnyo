import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export async function readMarkdownHeader(filePath: string): Promise<string> {
  const file = await fs.open(filePath, "r");

  try {
    const bytes = Buffer.alloc(4096);
    let content = "";
    const decoder = new StringDecoder("utf8");

    for (let size = 0; size < 64 * 1024; size += bytes.length) {
      const read = await file.read(bytes, 0, bytes.length, null);
      content +=
        read.bytesRead === 0
          ? decoder.end()
          : decoder.write(bytes.subarray(0, read.bytesRead));
      const trimmed = content.trimStart();

      if (trimmed === "" && read.bytesRead > 0) continue;

      if (!trimmed.startsWith("---\n") && !trimmed.startsWith("---\r\n"))
        return "";
      const close = /\r?\n---(?:\r?\n|$)/u.exec(trimmed.slice(3));

      if (close) return trimmed.slice(0, 3 + close.index + close[0].length);

      if (read.bytesRead === 0) return content;
    }

    throw new Error("Skill frontmatter exceeds 64 KiB");
  } finally {
    await file.close();
  }
}
