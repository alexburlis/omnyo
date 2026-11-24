---
name: invoice-to-epc-qr
description: Extract invoice payment fields and create a locally verified EPC QR image without initiating a transfer.
license: MIT
---

# Invoice to EPC QR

Turn a supplied EUR invoice into an EPC payment-data QR image and a readable field summary. Generating the image does not initiate a transfer, establish the payee's identity, or prove that an invoice remains unpaid.

## Read and reconcile the invoice

Use the document the user selected. Extract PDF text when available; use local OCR for a scan, then compare the payment area visually with the original. Record the source filename, invoice date, and file hash. Keep unrelated personal information out of logs and the payment payload.

Extract the beneficiary name, IBAN, supplied BIC, currency, amount due, invoice identifier, requested payment reference, and due date. Reconcile totals with credits, deposits, taxes, and partial-payment instructions. Preserve leading zeros and reference punctuation. Do not substitute an account from an older invoice.

Stop for conflicting bank details, uncertain OCR, multiple plausible balances, or missing required fields. Validate the IBAN's country length and MOD-97 checksum, but describe that result as a syntax check, not ownership verification. If changed bank details are suspicious, resolve them through a trusted channel before generating payment instructions.

## Encode a supported payload

Refresh the [EPC QR guidance](https://www.europeanpaymentscouncil.eu/document-library/guidance-documents/quick-response-code-guidelines-enable-data-capture-initiation) before implementation. The reference checked on 23 November 2026 is EPC069-12 version 3.1, dated 19 March 2024. This workflow handles invoice-style SCT data, with the payment fields also shown as text. It does not cover every point-of-sale QR scheme.

For UTF-8 version 002, serialize these ordered lines:

1. `BCD`
2. `002`
3. `1`
4. `SCT`
5. BIC, or an empty line where omission is permitted
6. Beneficiary name
7. IBAN
8. `EUR` followed by the decimal amount
9. Purpose code, or an empty line
10. Structured reference, or an empty line
11. Unstructured reference, or an empty line
12. Additional information, if used

Use LF separators and omit separators after the last populated field. Populate at most one reference form. Check current conditional BIC rules, including non-EEA participants. Enforce field limits and the 331-byte UTF-8 payload limit; amount must be within EUR0.01–EUR999999999.99. Generate error-correction level M, at most QR version 13. These format details come from the [official specification](https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2024-03/EPC069-12%20v3.1%20Quick%20Response%20Code%20-%20Guidelines%20to%20Enable%20the%20Data%20Capture%20for%20the%20Initiation%20of%20an%20SCT.pdf).

Treat decimal money as exact decimal or integer cents, not binary floating point. Reject embedded line breaks in fields. Never truncate a name or reference silently. Show the due date separately; do not turn it into an unsupported scheduled-payment field.

## Generate and independently inspect

Use a local QR encoder such as Python's `qrcode` package, with a separate decoder such as `zxing-cpp`. Respect the user's installed-tool and installation permissions. Record versions and generation options. Use an opaque light background, dark modules, integer scaling, and a quiet border; do not add a logo.

Save the payload, PNG, and verification result in the requested output directory. Decode the final PNG with the independent decoder and compare the recovered UTF-8 bytes exactly with the validated payload. Then parse the decoded fields and compare the beneficiary, IBAN, amount, and reference with the source extraction. A successful encoder call is not a verification result.

Use inert local fixtures when testing the toolchain. For example, round-trip the text `EPC-TOOLCHAIN-TEST-NOT-A-PAYMENT`; this tests image decoding only. A negative payment fixture can contain:

```json
{
  "beneficiary": "Fictional Test Recipient",
  "iban": "INVALID-FIXTURE-DO-NOT-PAY",
  "amount": "12.30",
  "currency": "EUR"
}
```

The negative fixture must be rejected before QR generation. Also test zero amount, conflicting reference forms, multiline fields, and byte overflow. Never send a fixture to a bank or use a plausible account as a fake beneficiary.

## Deliver

Show the QR beside the verified fields and source invoice identification. Report checksum, total reconciliation, payload validation, and independent image-decoding outcomes separately. If a check fails, withhold the payment QR and identify the unresolved field. State that no transfer was submitted. Banking-client compatibility is unverified unless the intended client was actually tested; the payer must review its prefilled fields before authorizing payment.
