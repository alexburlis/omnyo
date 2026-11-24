---
name: app-store-review-readiness
description: Audit an iOS or macOS submission against current Apple rules using source, packaged-artifact, runtime, and listing evidence.
license: MIT
---

# App Store Review Readiness

Assess a specific iOS, iPadOS, or macOS submission and identify material review risks or missing proof. This is an evidence audit, not a guarantee of acceptance or authorization to upload or submit a build.

## Bind the candidate

Record app and bundle identifiers, platform, distribution channel, version/build, source revision, archive identity, minimum OS, supported device families, regions, backend environment, and intended submission date. Distinguish the App Store candidate from development, direct-download, and internal variants.

Inventory account creation, sign-in, payments, subscriptions, user content, AI or remote processing, downloaded functionality, protected resources, extensions, entitlements, analytics, and third-party SDKs. Include remote configuration and account-gated features. An unknown capability is a coverage gap, not “not applicable.”

## Refresh the rules

Open the current [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/), [App Review preparation guidance](https://developer.apple.com/app-store/review/), [upcoming requirements](https://developer.apple.com/news/upcoming-requirements/), and [App Store Connect help](https://developer.apple.com/help/app-store-connect/). The starting links were checked on 23 November 2026; refresh them for each audit. Follow capability-specific links where the app requires them.

Record source URL, section, checked date, effective date where stated, platform, and region. Distinguish an effective requirement from an announcement, recommendation, contractual condition, and your interpretation. Do not infer a worldwide payment rule from one storefront's exception.

Build a coverage table from the live guideline sections, rather than relying on a frozen checklist. Mark each applicable section `supported`, `risk`, or `proof missing`; use `not applicable` only with an explanation. Track platform-specific requirements separately.

## Compare four evidence layers

| Layer                              | What it can establish                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Source and configuration           | Intended code paths, data flow, integrations, and feature conditions.                                |
| Packaged artifact                  | Actual identifiers, resources, entitlements, privacy manifests, signatures, and bundled behavior.    |
| Runtime                            | What the stated build does under recorded account, network, device, and permission conditions.       |
| Store listing and submission state | Metadata, declared privacy practices, availability, review information, and selected products/build. |

A source setting cannot prove the uploaded artifact contains it. A successful compile, notarization, or previous review cannot establish current App Store acceptance.

Select checks from actual capabilities. Inspect privacy-policy accessibility and consistency with data practices; account lifecycle; permission requests and denial paths; purchase, restore, and subscription presentation; user-content controls; reviewer access; metadata accuracy; and the completeness of the core experience. Review third-party SDK behavior as part of the app. Apple makes developers responsible for included SDKs. [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

For apps supporting account creation, inspect in-app initiation of deletion and what data is retained, with its stated basis. Apple's [account-deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/) explains the submission requirement; read it against the app's actual account model. Do not perform live deletion simply to complete an audit.

## Exercise reviewer journeys

Use isolated test accounts and authorized test purchases where needed. Cover first launch, sign-in, first useful outcome, permission refusal, unavailable network/backend, and relevant recovery paths. Select representative supported devices, screen sizes, and OS versions; list what was not tested.

Check that a reviewer can reach the submitted features using the provided instructions and available services. Confirm access without placing passwords, tokens, or real customer content in the report. Record a missing credential or device as a proof gap. Do not create accounts, reset permissions, charge money, change listing fields, or submit for review without authority for that action.

Capture exact steps, observed behavior, build identity, and sanitized evidence. Reuse valid evidence when its inputs are unchanged. After repeated identical failures, stop and identify the dependency instead of treating another retry as broader coverage.

## Report a bounded verdict

Use a finding record like this synthetic example:

```json
{
  "id": "R-01",
  "surface": "iOS candidate build 42",
  "check": "Reviewer can reach the core feature",
  "status": "proof missing",
  "evidence": "Demo account access was not available",
  "nextProof": "Exercise the documented sign-in path with an approved test account"
}
```

For every material issue, include affected platform/build/region, precise evidence, official rule and checked date, impact, and the smallest correction or missing check. Separate confirmed defects from interpretations and optional improvements.

Return `not ready` for demonstrated material blockers, `insufficient evidence` for material unknowns, or `no material risk found in checked scope` when the scoped evidence supports it. Include coverage exclusions and outstanding runtime or Store Connect proof. Remediation and submission remain separate actions governed by the user's request.
