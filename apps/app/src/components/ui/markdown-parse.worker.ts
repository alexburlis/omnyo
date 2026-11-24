import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import {
  markdownParseRequestSchema,
  type MarkdownParseResponse,
} from "./markdown-parse-protocol.js";

const processors = [false, true].map((directives) => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath, { singleDollarTextMath: false });

  if (directives) processor.use(remarkDirective);

  return processor.freeze();
});

addEventListener("message", (event: MessageEvent<unknown>) => {
  const parsed = markdownParseRequestSchema.safeParse(event.data);

  if (!parsed.success) throw new Error("Invalid Markdown parse request.");
  const request = parsed.data;
  let response: MarkdownParseResponse;

  try {
    const processor = processors[request.directives ? 1 : 0];

    if (processor === undefined) throw new Error("Missing Markdown parser.");
    response = { ...request, tree: processor.parse(request.source) };
  } catch {
    response = { ...request, error: "Markdown parse failed." };
  }

  postMessage(response);
});
