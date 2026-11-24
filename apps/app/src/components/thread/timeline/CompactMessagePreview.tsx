import { useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PromptTextMention } from "@omnyo/domain";
import {
  buildPromptMentionComponent,
  remarkPromptMentions,
  substitutePromptMentions,
} from "@/components/ui/markdown-prompt-mentions";
import {
  buildThreadMentionComponent,
  remarkThreadMentions,
} from "@/components/ui/markdown-thread-mentions";

const EMPTY_MENTIONS: readonly PromptTextMention[] = [];

const PREVIEW_PLUGINS = [remarkGfm, remarkThreadMentions, remarkPromptMentions];

function InlineContent({ children }: { children?: ReactNode }) {
  return <span>{children} </span>;
}

const PREVIEW_COMPONENTS: Components = {
  a: ({ children }) => <span>{children}</span>,
  blockquote: InlineContent,
  h1: InlineContent,
  h2: InlineContent,
  h3: InlineContent,
  h4: InlineContent,
  h5: InlineContent,
  h6: InlineContent,
  img: ({ alt }) => <span>{alt}</span>,
  li: InlineContent,
  ol: InlineContent,
  p: InlineContent,
  pre: InlineContent,
  table: InlineContent,
  tbody: InlineContent,
  td: InlineContent,
  th: InlineContent,
  thead: InlineContent,
  tr: InlineContent,
  ul: InlineContent,
};

export function CompactMessagePreview({
  text,
  mentions = EMPTY_MENTIONS,
  className,
}: {
  text: string;
  mentions?: readonly PromptTextMention[];
  className?: string;
}) {
  const substituted = useMemo(
    () => substitutePromptMentions(text, mentions),
    [mentions, text],
  );

  const components = useMemo<Components>(
    () => ({
      ...PREVIEW_COMPONENTS,
      "omnyo-prompt-mention": buildPromptMentionComponent({
        interactive: false,
        mentions: substituted.mentions,
      }),
      "omnyo-thread-mention": buildThreadMentionComponent({
        interactive: false,
        mentions,
      }),
    }),
    [mentions, substituted.mentions],
  );

  return (
    <span className={className}>
      <ReactMarkdown components={components} remarkPlugins={PREVIEW_PLUGINS}>
        {substituted.content}
      </ReactMarkdown>
    </span>
  );
}
