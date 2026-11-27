import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecordFence } from "../record-fields.ts";

const pickingValue =
  'Inbox shows 83 chats, omnyo-core shows 11, acme-app shows "No chats yet" + New chat, Personal starts with sub-chats collapsed';

const screenshotTable = `| Check on app.omnyohq.com | Result |
|---|---|
| Rail at 1440×900 | ✅ Inbox tile, 18 project tiles |
| Picking Inbox, a project, an empty project or Personal | ✅ ${pickingValue} |
| Rows after Inbox → project | ❌ 4 overlapping on the old bundle |
| Page errors | ✅ 0 |`;

test("a pipe table becomes a toned status table with full-length values", () => {
  assert.equal(pickingValue.length, 125);
  assert.deepEqual(parseRecordFence("status-table", screenshotTable), {
    ok: true,
    attributes: {
      columns: "Check on app.omnyohq.com|Result",
      labels:
        "Rail at 1440×900|Picking Inbox, a project, an empty project or Personal|Rows after Inbox → project|Page errors",
      values: `Inbox tile, 18 project tiles|${pickingValue}|4 overlapping on the old bundle|0`,
      tones: "positive|positive|negative|positive",
    },
  });
});

test("a table without status marks stays neutral", () => {
  const result = parseRecordFence(
    "status-table",
    "| Change | State |\n|---|---|\n| Plan | Local only |",
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && "tones" in result.attributes, false);
});

test("a three-column pipe table puts its third column in details", () => {
  assert.deepEqual(
    parseRecordFence(
      "status-table",
      "| Part | Physical? | Detail |\n|---|---|---|\n| Refraction | ✅ Yes | Snell's law |\n| View | ⚠️ No | |",
    ),
    {
      ok: true,
      attributes: {
        columns: "Part|Physical?|Detail",
        labels: "Refraction|View",
        values: "Yes|No",
        tones: "positive|warning",
        details: "Snell's law|",
      },
    },
  );
});

test("a third column name is kept and an unusable header is dropped", () => {
  const directive = (columns: string) =>
    parseRecordFence(
      "status-table",
      `::status-table{columns="${columns}" labels="Build" values="Passed" details="Exit 0"}`,
    );

  assert.equal(directive("Check|Result|Detail").ok ? "kept" : "", "kept");
  assert.deepEqual(directive("Check|Result|Detail|Extra"), {
    ok: true,
    attributes: { labels: "Build", values: "Passed", details: "Exit 0" },
  });
});

test("pipe table rows of uneven width keep every cell", () => {
  assert.deepEqual(
    parseRecordFence("status-table", "| A | B |\n|---|---|\n| One | Two | Three | Four |"),
    {
      ok: true,
      attributes: { labels: "One", values: "Two", columns: "A|B|", details: "Three · Four" },
    },
  );
});

test("file cards accept path for href in field lines and directives", () => {
  const fields = `title: Live-site evidence
path: /Users/me/docs/facts.json
meta: 20 files with hashes`;

  for (const code of [
    fields,
    '::file-card{title="Live-site evidence" path="/Users/me/docs/facts.json" meta="20 files with hashes"}',
  ]) {
    assert.deepEqual(parseRecordFence("file-card", code), {
      ok: true,
      attributes: {
        title: "Live-site evidence",
        href: "/Users/me/docs/facts.json",
        meta: "20 files with hashes",
      },
    });
  }
});

test("a directive line inside its own fence is accepted", () => {
  const result = parseRecordFence(
    "status-table",
    '::status-table{labels="Build|Tests" values="Passed|38/38" tones="positive|positive"}',
  );

  assert.deepEqual(result, {
    ok: true,
    attributes: { labels: "Build|Tests", values: "Passed|38/38", tones: "positive|positive" },
  });
});

test("a bracketed email address is plain text, not markup", () => {
  const result = parseRecordFence(
    "status-table",
    '::status-table{labels="Sender|Reply-To" values="Acme Operations <hello@example.com>|<ops-team@example.com>"}',
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
});

test("a placeholder inside a code span is plain text, not markup", () => {
  const result = parseRecordFence(
    "status-table",
    '::status-table{labels="Reload" values="Live" details="`omnyo plugin reload <id>` loads the source"}',
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
});

test("a bare command placeholder is plain text, not markup", () => {
  const result = parseRecordFence(
    "status-table",
    '::status-table{labels="Inbox cards" values="OK or Archive" details="Run omnyo inbox act <chat-id> ok, or <thread id> archive."}',
  );

  assert.equal(result.ok, true, result.ok ? "" : result.reason);
});

test("HTML formatting outside a code span invalidates the table", () => {
  for (const detail of [
    "line one<br>line two",
    "an <img src=x> image",
    "a <span class='x'>span",
    "a self-closing <hr/> rule",
    "an <!-- hidden --> comment",
    "a stray </div> close",
  ]) {
    const result = parseRecordFence(
      "status-table",
      `::status-table{labels="Row" values="Value" details="${detail}"}`,
    );

    assert.equal(result.ok, false, detail);
  }
});

test("a tag outside a code span still invalidates the table", () => {
  const result = parseRecordFence(
    "status-table",
    '::status-table{labels="Reload" values="Live" details="`reload <id>` then <b>bold</b>"}',
  );

  assert.equal(result.ok, false);
});

test("status-table values and details preserve paragraph-length explanations within their bounds", () => {
  const field = (name: string, length: number) =>
    parseRecordFence(
      "status-table",
      `::status-table{labels="Row" ${name === "details" ? 'values="Fixed" ' : ""}${name}="${"x".repeat(length)}"}`,
    );

  for (const [name, label, limit] of [
    ["values", "Value", 1200],
    ["details", "Detail", 500],
  ] as const) {
    assert.equal(field(name, limit).ok, true);
    const over = field(name, limit + 1);

    assert.equal(over.ok, false);
    assert.equal(over.ok ? "" : over.reason, `${label} 1 is longer than ${limit} characters`);
  }
});

test("HTML formatting in any status-table field is rejected", () => {
  const tags = ["<b>bold</b>", "</b>", "<br/>", "<br>", "<a href=x>", '<img src="x" onerror=y>'];

  for (const tag of tags) {
    const result = parseRecordFence(
      "status-table",
      `::status-table{labels="Row" values="Value ${tag}"}`,
    );

    assert.equal(result.ok, false, tag);
  }
});

test("a rejected status table still carries its rows for the readable fallback", () => {
  const result = parseRecordFence(
    "status-table",
    '::status-table{labels="Row" values="Value <br>"}',
  );

  assert.deepEqual(result.ok ? null : result.attributes, { labels: "Row", values: "Value <br>" });
});

test("common authoring slips render instead of failing", () => {
  const cases: Array<[Parameters<typeof parseRecordFence>[0], string]> = [
    ["status-table", "| A | B | C | D |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |"],
    ["status-table", "| A | B |\n| 1 | 2 |"],
    ["status-table", "| A | B |\n|---|---|\n| 1 |"],
    ["status-table", "labels: A\nvalues: B\nmood: happy"],
    ["status-table", '::status-table{labels="A|B" values="1|2" tones="good|sparkly"}'],
    ["status-table", '::status-table{labels="A|B" values="1|2" tones="positive"}'],
    ["status-table", '::status-table{labels="A|B" values="1|2" details="only one"}'],
    ["status-table", '::status-table{labels="A|B" values="1|" columns="Only"}'],
    ["file-card", '::file-card{title="Report" href="/a" path="/b"}'],
    ["file-card", "title: A\ntitle: B\nhref: /a"],
    ["file-card", "href: /Users/me/report.md"],
    ["file-card", "title: Report\nhref: /a\nkind: pdf"],
  ];

  for (const [language, code] of cases) {
    const result = parseRecordFence(language, code);

    assert.equal(result.ok, true, `${code}: ${result.ok ? "" : result.reason}`);
  }
});

test("a file card without a title is named after its file", () => {
  const result = parseRecordFence("file-card", "href: /Users/me/report.md");

  assert.equal(result.ok ? result.attributes.title : null, "report.md");
});

test("payloads that cannot render report a reason instead of succeeding", () => {
  const cases: Array<[Parameters<typeof parseRecordFence>[0], string, string]> = [
    [
      "status-table",
      `| A | B |\n|---|---|\n| Row | ${"x".repeat(1201)} |`,
      "Value 1 is longer than 1200",
    ],
    ["status-table", '::file-card{title="x" href="/a"}', "found ::file-card"],
    ["file-card", "title: Report", "path or link is missing"],
    [
      "file-card",
      '::file-card{title="Report" path="javascript:alert(1)"}',
      "not a file path or web address",
    ],
    ["file-card", "title: Report\nhref: javascript:alert(1)", "not a file path or web address"],
    ["file-card", "title: <b>Report</b>\nhref: /a", "title"],
    ["file-card", "just some prose", 'not a "field: value" line'],
    ["file-card", "   \n", "empty"],
  ];

  for (const [language, code, reason] of cases) {
    const result = parseRecordFence(language, code);

    assert.equal(result.ok, false, code);
    assert.match(result.ok ? "" : result.reason, new RegExp(reason.replace(/[()]/gu, "\\$&")));
  }
});

test("labels written row by row render when the repeated values prove each row", () => {
  assert.deepEqual(
    parseRecordFence(
      "status-table",
      '::status-table{label="Release" columns="Check|Result|Detail" labels="Core main|Contains the fix|Plugins main|Contains the fix|Release lane|Empty" values="Contains the fix|Contains the fix|Empty" tones="positive|positive|muted" details="Commit on origin/main|Pinned for new installs|Nothing queued"}',
    ),
    {
      ok: true,
      attributes: {
        label: "Release",
        columns: "Check|Result|Detail",
        labels: "Core main|Plugins main|Release lane",
        values: "Contains the fix|Contains the fix|Empty",
        tones: "positive|positive|muted",
        details: "Commit on origin/main|Pinned for new installs|Nothing queued",
      },
    },
  );
});

test("three cells per row supply the details when no details are given", () => {
  assert.deepEqual(
    parseRecordFence(
      "status-table",
      '::status-table{columns="Piece|Status|Detail" labels="Storage|Done|Committed| Sidebar |Done|Helper writing it" values="Done|Done"}',
    ),
    {
      ok: true,
      attributes: {
        columns: "Piece|Status|Detail",
        labels: "Storage| Sidebar ",
        values: "Done|Done",
        details: "Committed|Helper writing it",
      },
    },
  );
});

test("row-by-row labels stay invalid unless every repeated cell matches", () => {
  for (const directive of [
    '::status-table{labels="Build|Passed|Tests|Passed" values="Passed|Failed"}',
    '::status-table{labels="Storage|Done|Committed|Sidebar|Done|Helper writing it" values="Done|Done" details="Server tests pass|Menu and Undo toast"}',
    '::status-table{columns="Opportunity|Value" labels="Cache npm downloads|Concrete gap|Profile release checks|Avoidable work" values="Best first candidate|Second priority"}',
  ]) {
    const result = parseRecordFence("status-table", directive);

    assert.equal(result.ok ? "" : result.reason, "each row needs exactly one value");
  }
});
