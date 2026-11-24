---
name: search-content-evidence
description: Evaluate SEO and AI-search claims against primary sources and improve pages with useful, verifiable content.
license: MIT
---

# Search Content Evidence

Use evidence to decide whether a search tactic is supported and whether a page answers its intended reader. This workflow covers traditional search and AI-search visibility without promising ranking or citations.

## Fix the question and evidence boundary

Identify the exact product, query intent, audience, page, and proposed claim. Distinguish the reader's need from the publisher's desired metric. Inspect the current rendered page and its source before proposing a new page or rewriting an existing one.

Build a claim ledger. Each row needs the claim, primary source, relevant passage or result, checked date, product/version, conditions, and verdict:

- `documented`: the named provider explicitly describes the behavior.
- `observed`: a repeatable test demonstrated it under recorded conditions.
- `inferred`: evidence suggests it, but does not directly establish it.
- `unsupported`: the supplied evidence does not justify the claim.

Keep a study's method, population, and limitations attached to its result. A vendor case study, an enterprise search feature, or another product with a similar name does not establish how a public search engine ranks pages. Search snippets are discovery aids; read the linked primary source.

## Check tactics against the named engine

Refresh official documentation when the claim depends on current behavior. Start with [Google Search Essentials](https://developers.google.com/search/docs/essentials) and its [AI features guidance](https://developers.google.com/search/docs/appearance/ai-features) for Google. Use the corresponding provider's documentation for another engine instead of transferring Google's rules.

Google's AI features guidance, checked on 23 November 2026, describes ordinary SEO foundations and states that no special AI markup or additional technical requirements are needed. Eligibility does not guarantee indexing or inclusion. Treat fixed word counts, mandatory FAQ blocks, keyword ratios, and citation guarantees as claims requiring evidence, not default writing rules.

Read the relevant documentation before changing crawl, indexing, snippets, training access, or structured data. Those controls serve different purposes. Preserve the site's intentional privacy and indexing choices; a discoverability task does not authorize opening private content.

## Improve the answer

Lead with a direct answer and the conditions that could change it. Add information the reader can use: a verified example, explicit limitation, comparison with stated criteria, reproducible measurement, current procedure, or original analysis. Avoid padding a page to satisfy a speculative algorithm.

Every factual sentence should be supported by product evidence or a suitable source. Put material caveats beside the claim so an extracted passage remains accurate. Label synthetic examples. Never invent testimonials, author expertise, tests, customer results, or reviewer badges. Use headings, tables, images, and FAQs only when they improve comprehension.

Keep one canonical owner for a topic unless distinct intents justify separate pages. Ensure titles, descriptions, internal links, and structured data match visible content. Do not generate many near-duplicate pages or fabricate mentions to manufacture authority.

A synthetic editorial decision can be recorded as:

```json
{
  "claim": "Adding an FAQ guarantees an AI citation",
  "verdict": "unsupported",
  "decision": "Include questions only if they resolve actual reader uncertainty",
  "measurement": "Track observed referral and query changes without claiming causation"
}
```

## Verify and measure

Check the final rendered answer, links, canonical URL, HTTP status, applicable crawl/index directives, mobile readability, and structured-data correspondence. A validator pass establishes syntax, not eligibility for every rich result or search inclusion.

For an experiment, record baseline and change dates, page/query set, country, device, and measurement window before examining results. Compare impressions, clicks, meaningful conversions, and relevant referrals using available first-party analytics. Distinguish absent data from zero activity. Search positions and AI answers vary by time and context; retain the query and environment for observations.

Do not infer causation from a single before/after chart. Report concurrent releases, seasonality, indexing delays, small samples, and missing attribution. Provider reporting may combine AI and ordinary search traffic; do not manufacture a separate AI count from an aggregate.

## Deliver

Return the edited content or audit, the concise claim ledger, unresolved evidence needs, verification results, and a proportionate measurement plan. Keep publishing and analytics-configuration changes within the user's authority. Use source links next to the claims they support and state the date for changeable provider behavior.
