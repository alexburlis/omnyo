import { z } from "zod";

export const sha = z.string().regex(/^[a-f0-9]{40,64}$/u);

export const relativePath = z
  .string()
  .min(1)
  .max(600)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.split("/").includes("..") &&
      !Array.from(value).some((character) => character.codePointAt(0)! < 32),
    "Use a repository-relative path",
  );

export const text = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .refine(
    (value) =>
      !/\bBearer\s+\S+|\b(?:sk|ghp|gho|ghs)[_-][A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(
        value,
      ),
    "Remove credential material",
  );
