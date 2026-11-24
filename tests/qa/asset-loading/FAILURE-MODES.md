# Asset loading browser proof

Run from the repository root with the existing Playwright module and a new evidence directory:

`node --conditions=source --import tsx tests/qa/asset-loading/proof.mjs <existing-playwright-module> <evidence-directory>`

The proof uses a fresh Chrome profile, loopback HTTP, synthetic drafts, and tiny generated builds. It calls the production asset-cache helper, static route registration, and `defineSplit` default recovery. It does not start an Omnyo service, provider session, or account flow.

| Failure mode                                                    | Observable check                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replacing the current build loses an open client's lazy module. | Open build A, activate B and C, then click A's retained view. Chrome must fetch its uncached hashed module with HTTP 200 and render the A view.                  |
| The browser cache conceals an expired generation.               | A separate A lazy module stays unopened until D. Its first request must return HTTP 404, and the production split boundary must show Reload Omnyo.               |
| A rejected module download crashes the whole shell.             | The A shell and its synthetic draft remain visible beside the local reload action.                                                                               |
| Reload serves an obsolete shell or destroys the draft.          | Click the actual Reload Omnyo button. The resulting document must render D and preserve the same localStorage value and textarea draft.                          |
| Old assets accumulate without a bound.                          | After D, the helper must return exactly three complete generation roots, and A's unopened module must remain HTTP 404.                                           |
| Current HTML can stay stale in a browser.                       | Every activation's root HTTP response must identify the current build and use no-cache.                                                                          |
| The proof substitutes its own recovery or serving behavior.     | Bundle the actual `defineSplit`; route HTTP through the actual static registrar and prepare generations through the actual helper. Record source SHA-256 values. |
| Temporary browser files, listener, or generated builds survive. | Close the owned Chrome context and loopback listener in finally, remove the exact newly created scratch directory, and record absence in the retained receipt.   |

Retain a JSON receipt and two screenshots: the expired module's Reload Omnyo state and the recovered D shell with its draft. Generated sources, bundles, cache generations, browser home, and Chrome profile are disposable scratch.
