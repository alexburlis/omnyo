---
name: launch-venue-ledger
description: Research launch venues and maintain an evidence-backed submission ledger that prevents duplicate outreach.
license: MIT
---

# Launch venue ledger

Use this skill to compare places to list a product and keep its submission history understandable. It supplies a method and a small data model, not a venue database. All names, dates, and URLs in the example are fictional.

## Separate facts from attempts

Keep three collections in the user's chosen local format:

| Collection | Store here                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Venues     | Stable venue ID, audience, accepted product types, exact submission route, cost classification, requirements, source URL, and check date. |
| Products   | Stable product ID, audience, platform, license, available assets, budget constraint, and any venue-specific hold.                         |
| Events     | Unique event ID, product ID, venue ID, observation date, status, evidence reference, and execution owner when work is active.             |

Use `free`, `paid`, `mixed`, or `unknown` for cost. A possible free tier does not make a mixed offer free. Label evidence as directly observed, owner-reported, or imported. An imported note retains its original date and needs a current check before action.

Keep product-specific eligibility and history out of the shared venue record. The same venue can fit one product and reject another.

```json
{
  "event_id": "sample-notes-example-directory-01",
  "product_id": "sample-notes",
  "venue_id": "example-directory",
  "observed_at": "2030-01-15",
  "status": "submitted",
  "evidence_kind": "fixture",
  "evidence": "fixtures/form-receipt.txt",
  "note": "Synthetic receipt only; a public listing is not established."
}
```

## Find the next useful venue

1. Establish the product's audience and what can actually be submitted today. Read existing holds and attempts before making recommendations.
2. Select a small set by audience fit. Separate directories, editorial pitches, communities, stores, and technical integrations; their effort and outcomes differ.
3. Inspect each publisher's current submission rules and exact route. Record the source and date for cost, eligibility, required assets, and restrictions on automated or promotional submissions. A homepage is not evidence of an available form.
4. Check the ledger, existing public placements, and user-provided receipts for prior attempts. A search with no result means only that the search found none.
5. Rank the remaining options by fit, readiness, effort, and documented constraints. Return the submission URL and evidence next to each recommendation. Do not predict traffic or conversions from a listing alone.

A request to research or prepare a submission does not itself authorize sending, posting, paying, creating an account, or accepting terms. Reuse explicit authority already provided for those actions.

## Record an authorized attempt

Reserve active work with an owner and a dated status so a second operator can see it. Append observations instead of overwriting earlier events. Useful states include `planned`, `in-progress`, `submitted`, `accepted`, `live`, `rejected`, and `withdrawn`.

Treat these as distinct evidence:

- A form receipt establishes submission.
- A maintainer response may establish acceptance.
- An observed public page establishes a live placement at that time.
- Analytics can establish measured visits; none of the earlier states establishes growth.

For concurrent writers, use a transactional store or a lock around read, duplicate-ID check, and append. An identical event retry is a no-op; a conflicting event with the same ID needs review. Never repeat an external submission merely because a receipt was lost. Inspect the existing attempt first.

## Finish

Check that every event references a known product and venue, IDs are unique, dates and evidence labels are present, and an old observation has not silently become current fact. Report the observed status, source, cost uncertainty, and any next decision. Share only evidence the user is entitled to publish; keep credentials, private correspondence, and personal contact details out of the public ledger.
