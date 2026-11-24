---
name: verified-link-previews
description: Create and verify web share metadata and preview assets, including optional video range delivery and native rendering checks.
license: MIT
---

# Verified Link Previews

Make a shared URL produce the intended title, description, image, and optional video on the target sharing clients. Verify the delivered page and assets as well as the metadata source.

## Inventory the share surface

Choose representative URLs from each page type, including one deep route and one missing or invalid resource. Record the expected canonical URL, title, summary, preview image, locale, and client. Confirm that private or authenticated content is not unintentionally exposed to crawlers.

Read the actual HTML returned to an unauthenticated request, not only a client-side DOM. Locate canonical, Open Graph, and client-specific card metadata. Check for duplicate tags and defaults inherited from a layout. Framework metadata objects may merge differently from plain objects; inspect the generated result.

Use absolute public HTTPS asset URLs where the consumer requires them. Every title, summary, and image must describe that exact page. Avoid baking frequently changing counts, prices, or availability into artwork unless the project has an update mechanism.

## Prepare the assets

Use artwork and fonts the project has permission to distribute. Create an image at the aspect ratio required by the chosen clients; a 1200 × 630 image is a useful starting candidate, not a universal contract. Keep key content readable when cropped and at thumbnail size. Provide a meaningful image description when supported.

Keep a deterministic source for each generated asset and record its output hash, format, dimensions, and byte size. Open the actual encoded image to detect missing fonts, clipped text, transparency surprises, and export failures. Use a content-versioned URL when caches could otherwise retain obsolete artwork.

Add video only when the product benefits from it and the target client supports it. Supply a poster image so a client that ignores video still has a useful preview. Inspect the encoded container, codec, duration, dimensions, and audio tracks with a tool such as `ffprobe`; do not infer them from the filename.

## Verify transport

Use an HTTP client such as curl against the final public route through its real proxy or CDN. Record status, redirects, content type, response size, and caching headers. For each image, download and decode the returned bytes. A successful HEAD request alone cannot establish that the GET body is valid.

For an optional MP4, send a bounded range request, such as `Range: bytes=0-1023`. Check that the endpoint returns the intended partial body, an accurate `Content-Range`, and a length consistent with the returned bytes. If the client needs byte ranges, a server returning the whole file with status 200 has not passed that requirement. Check the selected content encoding; intermediary compression can interfere with range behavior.

A synthetic result record can use this shape:

```json
{
  "page": "https://example.com/library/demo",
  "canonicalMatches": true,
  "image": { "status": 200, "decoded": true, "width": 1200, "height": 630 },
  "video": { "tested": false },
  "clientChecks": [{ "client": "target client", "result": "not run" }]
}
```

The example is a schema illustration, not a claim that those requests occurred.

## Verify the consumer

Test with each requested sharing client or its official inspector when available. Use Apple LinkPresentation on an available Apple platform when Apple rendering is in scope, and inspect the resulting preview in its actual presentation surface. Do not equate browser video playback, valid HTML, or an inspector response with a rendered Messages preview.

Record client and OS versions, test URL, timestamp, screenshot, and whether the preview came from a fresh fetch or may be cached. When a client cannot be tested, label it unverified. Do not send messages to other people as part of a preview check without authorization.

## Deliver

Provide a page-type matrix with expected and observed metadata, asset checks, range results where applicable, and native-client evidence. Explain stale caches or unsupported client behavior separately from source defects. Include the regeneration command or editing location. An HTTP pass establishes transport; only a client rendering check establishes that client's appearance. Publish changes only under the user's delivery authority.
