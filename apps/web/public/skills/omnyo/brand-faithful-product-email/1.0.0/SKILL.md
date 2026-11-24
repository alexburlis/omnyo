---
name: brand-faithful-product-email
description: Design and preview a product email in MJML using the product's visual identity, readable text, and synthetic data.
license: MIT
---

# Brand-faithful product email

Use this skill for email design and local rendering. It does not send mail, configure a delivery service, or import contacts. The example brand, message, and destination below are fictional.

## Establish the design contract

Read the supplied brand guide or current product design before editing. Record the approved mark, surface and text colors, accent role, type hierarchy, spacing, corner treatment, and voice. Separate current design decisions from old mockups. If no brand exists, make a clearly labeled proposal instead of presenting invented assets as official.

Map that identity into the email renderer's existing shell. Keep shared header, footer, legal text, and delivery-specific links in their owning layer. Author a body fragment when that renderer expects one. Do not create a second shell inside it or migrate providers as part of a visual change.

Web fonts, CSS support, and dark-mode behavior vary by email client. Choose readable fallback fonts; preserve the message as live text. Use approved images with useful alternative text, and ensure the message remains understandable when images are blocked. Never invent a replacement logo without a design request.

## Build the message

Determine the actual purpose: a receipt, account action, confirmation, or promotional message. Preserve that purpose and any required wording. An account message does not imply permission to add marketing.

Write the subject, preheader, body, primary action, and plain-text alternative together. Say what the action does. Preserve significant characters such as leading zeros in codes. Do not invent an expiry, guarantee, price, or urgency. Escape dynamic text with the renderer's supported mechanism and validate destinations separately.

Here is a complete, portable MJML design fixture. It requires an installed MJML compiler; it has no delivery integration. `Cedar Notes` is a fictional product with a cream surface, forest-green accent, and serif headings. The reserved `.example` destination is intentionally inert.

```xml
<mjml>
  <mj-head>
    <mj-title>Cedar Notes: Your sample export is ready</mj-title>
    <mj-preview>The fictional export can be reviewed in your workspace.</mj-preview>
    <mj-attributes>
      <mj-all font-family="Arial, sans-serif" color="#20382b" />
      <mj-text font-size="16px" line-height="1.6" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f6f2e8" width="600px">
    <mj-section padding="32px 24px 16px">
      <mj-column>
        <mj-text font-family="Georgia, serif" font-size="24px">Cedar Notes</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" padding="24px">
      <mj-column>
        <mj-text font-family="Georgia, serif" font-size="28px">Your sample export is ready</mj-text>
        <mj-text>Review the fictional notebook export in your workspace.</mj-text>
        <mj-button href="https://cedar-notes.example/exports/sample" background-color="#28543c" color="#ffffff" border-radius="4px">Review sample export</mj-button>
        <mj-text>If you did not request this sample, no action is needed.</mj-text>
      </mj-column>
    </mj-section>
    <mj-section padding="16px 24px 32px">
      <mj-column>
        <mj-text font-size="14px">Cedar Notes · Fictional rendering fixture</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
```

The middle section is the body boundary for this fixture. In a real project, adapt the existing shell rather than copying this entire document into a fragment field. Replace fixture destinations only with reviewed product-owned links.

## Verify the rendered result

Compile with the project's pinned MJML version and inspect the HTML alongside the current product design. Check narrow and wide layouts, long synthetic names and URLs, fallback fonts, focus and link visibility, and images-blocked readability. Inspect the plain-text version independently. Test dynamic escaping with characters such as `&`, `<`, and quotes using synthetic values.

If the project supports dark mode, examine its declared modes and representative clients. Check text contrast on the surfaces actually rendered; a brand swatch alone does not establish accessible contrast. Record any untested clients.

Return the source, rendered preview, plain text, and a short list of checked conditions. A browser rendering establishes layout in that browser. It does not establish mailbox-client rendering, deliverability, consent, or successful delivery. Any inbox test needs separate authorization and an approved test recipient.
