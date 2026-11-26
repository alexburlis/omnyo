import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FeatureFrame } from "../feature-frame";
import { FeatureVisual } from ".";

describe("streamed feature artwork", () => {
  it("renders the illustration and its accessible label in server HTML", async () => {
    const stream = await renderToReadableStream(<FeatureVisual id="usage" />);
    const html = await new Response(stream).text();

    expect(html).toContain('class="fv-box" role="img"');
    expect(html).toContain('aria-label="The Account usage popover');
    expect(html).toContain('class="fv fv-usage"');
    expect(html).toContain("Account usage");
  });

  it("keeps the terminal hero interactive while ordinary frames use its artwork", async () => {
    const stream = await renderToReadableStream(
      <>
        <FeatureFrame id="terminal" className="fx-top-frame" interactive />
        <FeatureFrame id="terminal" />
      </>,
    );

    const html = await new Response(stream).text();

    expect(html).toContain('<div class="fx-top-frame">');
    expect(html).toContain("<form");
    expect(html).toContain('class="fx-frame"');
    expect(html).toContain('class="fv-box" role="img"');
  });
});
