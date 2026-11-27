import { isBoundedJson, type JsonValue } from "../contracts/definition.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Canonical encoding validates arbitrary boundary JSON before traversal.
export function canonicalJson(value: unknown): string {
  if (!isBoundedJson(value, 262144, 64)) throw new Error("Value is not bounded JSON");

  const encode = (item: JsonValue): string => {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Discriminate the validated recursive JSON union.
    if (item === null || typeof item !== "object") return JSON.stringify(item);

    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;

    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(item[key]!)}`)
      .join(",")}}`;
  };

  return encode(value);
}
