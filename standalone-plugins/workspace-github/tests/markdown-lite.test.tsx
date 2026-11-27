// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { Markdown } from "../components/markdown-lite";

afterEach(cleanup);

const RENOVATE_BODY = `This PR contains the following updates:

| Package | Change | [Age](https://docs.renovatebot.com/merge-confidence/) |
|---|---|---|
| [next](https://nextjs.org) ([source](https://redirect.github.com/vercel/next.js)) | [\`16.4.5\` → \`16.4.6\`](https://renovatebot.com/diffs/npm/next/16.4.5/16.4.6) | ![age](https://developer.mend.io/api/mc/badges/age/npm/next/16.4.6?slim=true) |

---

### Release Notes

<details>
<summary>vercel/next.js (eslint-config-next)</summary>

### [\`v16.4.6\`](https://redirect.github.com/vercel/next.js/releases/tag/v16.4.6)

> \\[!NOTE]
> This release is backporting bug fixes. It does **not** include all pending features/changes on canary.

##### Core Changes

- \\[lts-active] Pin Tailwind to 4.3.3 ([#&#8203;101061](https://redirect.github.com/vercel/next.js/issues/101061), [#&#8203;101176](https://redirect.github.com/vercel/next.js/issues/101176))
- \\[lts-active] Turbopack GC fixes for dev ([#&#8203;100279](https://redirect.github.com/vercel/next.js/issues/100279))

Huge thanks to [@&#8203;lukesandberg](https://redirect.github.com/lukesandberg) for helping!

</details>

---

### Configuration

- Branch creation
  - Only on Monday (\`* * * * 1\`)

 - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box

---

Hosted CI is skipped.
<!--renovate-debug:eyJjcmVhdGVkSW5WZXIiOiI0NC4xNzYuMiJ9-->`;

const DEPENDABOT_BODY = `Bumps [undici](https://github.com/nodejs/undici) from 7.30.1 to 7.30.2.
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/nodejs/undici/releases">undici's releases</a>.</em></p>
<blockquote>
<h2>v7.30.2</h2>
<p>Redirect hops honor <code>Vary</code> &amp; freshness.</p>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/nodejs/undici/commit/3df9ff5"><code>3df9ff5</code></a> test(cache): align</li>
<li><a href="https://github.com/nodejs/undici/commit/4d54152"><code>4d54152</code></a> fix(cache): detect</li>
</ul>
</details>
<br />

> **Note**
> Automatic rebases have been disabled.`;

function renderMarkdown(content: string) {
  const Surface = () => <Markdown content={content} />;

  return renderSlot({ component: Surface }, {}).container;
}

it("decodes numeric and named entities and drops zero-width spaces", () => {
  const container = renderMarkdown(
    "Fixes #&#8203;101061 by @&#x200B;lukesandberg &amp; co: &lt;tag&gt; &quot;q&quot; &#39;s&#39; a&nbsp;b &mdash; done &bogus; &#0;",
  );

  const text = container.textContent ?? "";

  expect(text).toContain("Fixes #101061 by @lukesandberg");
  expect(text).toContain("& co: <tag> \"q\" 's' a\u00a0b \u2014 done &bogus; &#0;");
  expect(text).not.toContain("&#8203;");
  expect(text).not.toContain("\u200b");
  expect(container.querySelector("tag")).toBeNull();
});

it("does not double-decode entities", () => {
  expect(renderMarkdown("&amp;lt;b&amp;gt;").textContent).toBe("&lt;b&gt;");
});

it("renders details collapsed with a summary and recursive markdown", () => {
  const container = renderMarkdown(
    "<details>\n<summary>Show <b>more</b></summary>\n\n- one\n- **two**\n\n```\n<details>\n```\n</details>",
  );

  const details = container.querySelectorAll("details");

  expect(details).toHaveLength(1);
  expect(details[0].open).toBe(false);
  expect(details[0].querySelector("summary")?.textContent).toBe("Show more");
  expect(details[0].querySelector("summary strong")?.textContent).toBe("more");
  expect(details[0].querySelectorAll("li")).toHaveLength(2);
  expect(details[0].querySelector("li strong")?.textContent).toBe("two");
  expect(details[0].querySelector("pre")?.textContent).toBe("<details>");
});

it("renders nested details and an open attribute", () => {
  const container = renderMarkdown(
    "<details open><summary>Outer</summary>\nouter text\n<details><summary>Inner</summary>\ninner text\n</details>\nafter\n</details>",
  );

  const outer = container.querySelector("details");
  const inner = outer?.querySelector("details");

  expect(outer?.open).toBe(true);
  expect(inner?.open).toBe(false);
  expect(inner?.querySelector("summary")?.textContent).toBe("Inner");
  expect(inner?.textContent).toContain("inner text");
  expect(inner?.textContent).not.toContain("after");
  expect(outer?.textContent).toContain("after");
  expect(container.textContent).not.toContain("<");
});

it("closes an unterminated details block and ignores a stray closing tag", () => {
  const container = renderMarkdown("</details>\n<details><summary>Open end</summary>\nbody");

  expect(container.querySelectorAll("details")).toHaveLength(1);
  expect(container.textContent).toContain("body");
  expect(container.textContent).not.toContain("<");
});

it("strips HTML comments but keeps them inside code", () => {
  const container = renderMarkdown(
    "before <!-- hidden\nacross lines --> after\n\n`<!-- kept -->`\n\n```\n<!-- fenced -->\n```",
  );

  const text = container.textContent ?? "";

  expect(text).toContain("before  after");
  expect(text).not.toContain("hidden");
  expect(text).toContain("<!-- kept -->");
  expect(text).toContain("<!-- fenced -->");
});

it("renders br, inline html equivalents and links through anchors", () => {
  const container = renderMarkdown(
    'a<br>b<br/>c <b>bold</b> <strong>strong</strong> <i>it</i> <em>em</em> <code>&lt;x&gt;</code> <a href="https://example.com/?a=1&amp;b=2">link</a>',
  );

  expect(container.querySelectorAll("br")).toHaveLength(2);
  expect(container.querySelectorAll("strong")).toHaveLength(2);
  expect(container.querySelectorAll("em")).toHaveLength(2);
  expect(container.querySelector("code")?.textContent).toBe("<x>");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/?a=1&b=2");
  expect(container.textContent).not.toContain("<b>");
});

it("drops unknown tags and keeps their text", () => {
  const container = renderMarkdown(
    '<p align="center"><span style="color:red">kept</span> <marquee>moving</marquee></p>\n\n</mystery> <custom-element data-x="1">inner</custom-element>',
  );

  const text = container.textContent ?? "";

  expect(text).toContain("kept");
  expect(text).toContain("moving");
  expect(text).toContain("inner");
  expect(text).not.toMatch(/<\/?[a-z]/i);
  expect(container.querySelector("span, marquee, custom-element")).toBeNull();
});

it("never injects raw html or unsafe links", () => {
  const container = renderMarkdown(
    '<script>window.hacked = 1</script><img src="x" onerror="window.hacked = 1">[click](javascript:alert(1)) <a href="javascript:alert(2)" onclick="x()">bad</a> <div onclick="x()">d</div>',
  );

  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("[onclick], [onerror]")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).toContain("click");
  expect(container.textContent).toContain("bad");
});

it("renders badge images, including inside links", () => {
  const container = renderMarkdown(
    "[![age](https://developer.mend.io/badges/age.svg?a=1&amp;b=2)](https://docs.renovatebot.com/merge-confidence/) ![local](./a.png)",
  );

  const image = container.querySelector("a img");

  expect(image?.getAttribute("src")).toBe("https://developer.mend.io/badges/age.svg?a=1&b=2");
  expect(image?.getAttribute("alt")).toBe("age");
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://docs.renovatebot.com/merge-confidence/",
  );
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.textContent).toContain("local");
  expect(container.textContent).not.toContain("](");
});

it("renders GitHub alerts as labeled blockquotes", () => {
  const container = renderMarkdown(
    "> [!WARNING]\n> Be **careful**\n\n> \\[!NOTE]\n> escaped marker",
  );

  const quotes = container.querySelectorAll("blockquote");

  expect(quotes).toHaveLength(2);
  expect(quotes[0].querySelector("p")?.textContent).toBe("Warning");
  expect(quotes[0].querySelector("strong")?.textContent).toBe("careful");
  expect(quotes[1].querySelector("p")?.textContent).toBe("Note");
  expect(container.textContent).not.toContain("[!");
  expect(container.textContent).not.toContain("\\[");
});

it("keeps tables, lists, headings, rules and code blocks", () => {
  const container = renderMarkdown(
    "# Title\n\n| A | B |\n|:--|--:|\n| 1 | **2** |\n\n1. first\n2. second\n\n* bullet\n- [x] done\n- [ ] todo\n\n---\n\n```\ncode\n```",
  );

  expect(container.querySelector("h1")?.textContent).toBe("Title");
  expect(container.querySelectorAll("th")).toHaveLength(2);
  expect(container.querySelector("td strong")?.textContent).toBe("2");
  expect(container.querySelectorAll("ol > li")).toHaveLength(2);
  expect(container.querySelectorAll("ul > li")).toHaveLength(3);
  expect(
    Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).map(
      (input) => input.checked,
    ),
  ).toEqual([true, false]);
  expect(container.querySelector("hr")).not.toBeNull();
  expect(container.querySelector("pre")?.textContent).toBe("code");
});

it("uses only sanctioned tailwind tokens", () => {
  const html = renderMarkdown(RENOVATE_BODY + DEPENDABOT_BODY).innerHTML;

  expect(html).not.toMatch(/text-\[/);
  expect(html).not.toMatch(/(?:bg|text|border)-(?:red|green|blue|yellow|amber|gray|slate)-\d/);
});

it("renders a Renovate body without raw html, entities or escapes", () => {
  const container = renderMarkdown(RENOVATE_BODY);
  const text = container.textContent ?? "";
  const details = container.querySelectorAll("details");

  expect(details).toHaveLength(1);
  expect(details[0].open).toBe(false);
  expect(details[0].querySelector("summary")?.textContent).toBe(
    "vercel/next.js (eslint-config-next)",
  );
  expect(text).not.toContain("<details>");
  expect(text).not.toContain("<summary>");
  expect(text).not.toContain("</details>");
  expect(text).not.toContain("&#8203;");
  expect(text).not.toContain("rebase-check");
  expect(text).not.toContain("renovate-debug");
  expect(text).toContain("#101061");
  expect(text).toContain("@lukesandberg");
  expect(text).toContain("[lts-active] Pin Tailwind");
  expect(text).toContain("Hosted CI is skipped.");
  expect(details[0].querySelector("blockquote p")?.textContent).toBe("Note");
  expect(container.querySelector("table img")?.getAttribute("alt")).toBe("age");
  expect(container.querySelectorAll("a[href]").length).toBeGreaterThan(5);
  expect(container.querySelector("input[type=checkbox]")).not.toBeNull();
});

it("renders a Dependabot body with html blocks as markdown", () => {
  const container = renderMarkdown(DEPENDABOT_BODY);
  const details = container.querySelectorAll("details");
  const text = container.textContent ?? "";

  expect(details).toHaveLength(2);
  expect(details[0].querySelector("summary")?.textContent).toBe("Release notes");
  expect(details[0].querySelector("blockquote h2")?.textContent).toBe("v7.30.2");
  expect(details[0].querySelector("blockquote code")?.textContent).toBe("Vary");
  expect(details[0].textContent).toContain("Vary & freshness.");
  expect(details[0].querySelector("em a")?.getAttribute("href")).toBe(
    "https://github.com/nodejs/undici/releases",
  );
  expect(details[1].querySelectorAll("li")).toHaveLength(2);
  expect(details[1].querySelector("li a code")?.textContent).toBe("3df9ff5");
  expect(text).not.toMatch(/<\/?[a-z]/i);
  expect(container.querySelectorAll("blockquote")).toHaveLength(2);
});

it("hides link reference definitions such as Dependabot markers, as GitHub does", () => {
  const text =
    renderMarkdown(
      "[//]: # (dependabot-start)\nBumps zod.\n\n[//]: # (dependabot-end)\n[docs]: https://example.com",
    ).textContent ?? "";

  expect(text).toBe("Bumps zod.");
});
