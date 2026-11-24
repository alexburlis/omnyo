# History exports

Resolved environment diagnostics retain each entry name, source, and reason, but replace every value with `{masked: true}`. The child environment receives the original values. The server also masks diagnostics from older daemons before persistence. The wire schema already accepts this mask; no daemon version change is required.

The public events and event-wait, timeline and turn-summary details, conversation outline, message/context, output, queued messages, prompt history, and compact conversation endpoints redact supported credential text. The SDK and CLI read those endpoints. Raw JSON keeps its event array shape, sequences, and event types; internal fork/replay readers retain their original data. Historical database rows are not rewritten.

The repository-owned redactor in `packages/domain/src/credential-redaction.ts` masks string fields with singular or plural credential names and strings nested below those fields, short labelled text values, authorization bearer values, complete or truncated PEM private keys, JWTs, and the supported OpenAI, GitHub, Slack, Omnyo (`omnyode_`, `omnyodh_`, `omnyocm_`, `omnyocred_` and their earlier `bb` forms), and AWS access-key patterns. Numeric counters remain numeric. Public-prefixed fields are excluded from credential-name classification. Exact copies of credential-named values from historical environment diagnostics are also removed, including when the diagnostic lies outside the requested event page. This is a maintained supported subset of the existing secret-barrier and recording redaction rules, not a claim of complete secret detection.

History redaction fails with HTTP 413 and code `history_redaction_limit` when its bounds are exceeded or recognized structured JSON text cannot be validated. Bounds are 1024 diagnostic events per thread, 1024 distinct nonempty known values totalling at most 1 MiB of characters, 16 MiB of processed string characters, 100,000 visited fields, and 64 object nesting levels per response. The raw-event response retains its existing 8 MiB data limit. This protects the returned payload; it does not make canonical projection work constant.

Plugin tool text is redacted before synchronous, detached, and failed results reach the model. Valid JSON text is parsed for nested credential fields; unchanged text retains its original bytes, while redacted JSON is serialized with its original structure and numeric counters. A JSON object starts with a quoted key or closing brace; a JSON array starts with a JSON value, closing bracket, or end of input. Recognized JSON parse errors withhold content. Ordinary logs such as `[INFO] build passed` and non-JSON code use the supported text patterns. Its text budget is shared across content items. A result that exceeds the redaction budget returns a fixed unsuccessful result with no raw content. Plugin image content is not inspected. Native provider shell/MCP outputs can reach their provider before server persistence and do not pass through this plugin boundary. Direct database access, provider transcripts, image content, and unknown unlabelled opaque values absent from the known-value set are outside this guarantee. No live credential reads are required.

## Compact conversation pagination

`GET /threads/:id/conversation`, `sdk.threads.conversation({threadId, limit?, afterSeq?, throughSeq?})`, and `omnyo thread log <id> --format conversation` return:

```json
{
  "rows": [{ "seq": 4, "role": "assistant", "text": "Visible answer" }],
  "hasMore": true,
  "nextAfterSeq": 4,
  "maxSeq": 9
}
```

The default limit is 20; valid limits are 1–100. Rows use original message sequences in ascending order. Continue with `afterSeq=nextAfterSeq` and `throughSeq=maxSeq`; the CLI equivalents are `--after-seq` and `--through-seq`. A completed page has `nextAfterSeq: null`. CLI `--all` holds the first page's upper sequence bound. Existing `--json`, minimal, and verbose output contracts remain available.

The canonical conversation projection determines visible messages, accepted/pending steer handling, and agent-only input filtering. Its targeted event selection and related accepted/rejected request reads stop at `maxSeq`. Each page still reads and projects the selected history through that bound; CPU and memory scale with that snapshot, rather than with the page limit. The upper bound excludes later appends, but does not freeze edits or other current thread state. Restart pagination after a history edit or a context-clear visibility change.
