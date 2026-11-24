# Native composer prediction proof

Authored before the native proof script. This proof owns the real Codex process,
Responses transport and persisted-history boundary. Existing native unit tests
use a fake executable; existing pool and composer tests own allowance admission,
capability validation, draft insertion and cancellation. No production seam is
required for this proof.

| Failure                                                                            | Observable proof                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A stale or incompatible installed CLI cannot run the production protocol.          | Require Codex 0.163.0, create a persisted parent with the production `NativeSession`, then invoke production `predictNative` with that parent's ID.                                                                                                                                                                      |
| The proof inherits provider credentials, MCP configuration or the real Codex home. | Clear the proof process environment before creating children. Use only system paths, locale and newly created home, Codex home, workspace and temporary directories; write synthetic file authentication only.                                                                                                           |
| A request escapes to a live inference provider.                                    | Configure only a loopback Responses route, API authentication and disabled analytics. Reject every fixture route except the two expected Responses requests. No real account or provider credential is available. This is configured isolation, not an operating-system network sandbox.                                 |
| The fork silently uses a local default model.                                      | Configure a Daybreak default distinct from the persisted gpt-5.4 parent. Require both native Responses requests to retain gpt-5.4; the production runner reads and pins the source model at fork creation, without a turn override.                                                                                      |
| A prediction targets or changes its source conversation.                           | Check request header and metadata identity against the persisted parent. Require a different child ID, the parent's fork identity, and identical parent rollout bytes before and after prediction.                                                                                                                       |
| The native request loses prediction tagging.                                       | Require `composer_predictions` in both thread-source and turn-trigger metadata emitted by Codex.                                                                                                                                                                                                                         |
| A prediction can invoke inherited tools or store the response.                     | Preserve a realistic parent with a synthetic dynamic tool. Require the native child to inherit that declaration. Pass its actual request through production `composerPredictionBody`; require preserved declarations and metadata, mandatory `tool_choice: "none"` and `store: false`. The fixture never invokes a tool. |
| The script merely returns fixture text without executing the runner.               | Return standard Responses SSE from the local HTTP fixture and require the production runner's exact suggestion, archive assessment and prompt version. Observe a real installed native child for both requests.                                                                                                          |
| A failed or completed run leaves an owned process, listener or temporary data.     | Abort and await native work in `finally`; close the loopback listener; verify observed owned native processes exited; remove only the freshly created scratch directory and verify its absence. Retain a sanitized success or failure receipt outside scratch.                                                           |

Run from the repository root:

```sh
node --conditions=source --import tsx tests/qa/composer-predictions/proof.mjs --codex /Users/developer/.local/bin/codex --output .tmp/composer-predictions-proof/native-receipt.json
```

The receipt establishes local native and wire behavior. It does not establish
live account eligibility, included allowance, production availability or the
official desktop beta's free billing treatment. No model runs behind the local
fixture, and no UI or screenshot claim is made.

The stable CLI inherits persisted dynamic tool declarations during a fork.
The forwarding boundary disables tool selection with `tool_choice: "none"`.
The proof records declarations separately from that forwarding restriction;
retained attempt 10 demonstrates the inherited declaration before the repair.
