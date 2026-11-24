interface GetMarkdownCodeLanguageArgs {
  className: string | undefined;
}

interface IsMarkdownCodeBlockArgs {
  className?: string;
  codeText: string;
  language: string | null;
}

const MARKDOWN_CODE_LANGUAGE_CLASS_PREFIX = "language-";

const MARKDOWN_INLINE_MATH_CLASS = "math-inline";

export function getMarkdownCodeLanguage({
  className,
}: GetMarkdownCodeLanguageArgs): string | null {
  const classNames = className?.split(/\s+/u) ?? [];

  for (const classNamePart of classNames) {
    if (!classNamePart.startsWith(MARKDOWN_CODE_LANGUAGE_CLASS_PREFIX)) {
      continue;
    }

    const language = classNamePart
      .slice(MARKDOWN_CODE_LANGUAGE_CLASS_PREFIX.length)
      .trim();

    return language.length > 0 ? language.toLowerCase() : null;
  }

  return null;
}

export function isMarkdownCodeBlock({
  className,
  codeText,
  language,
}: IsMarkdownCodeBlockArgs): boolean {
  if (className?.split(/\s+/u).includes(MARKDOWN_INLINE_MATH_CLASS)) {
    return false;
  }

  return language !== null || codeText.includes("\n");
}
