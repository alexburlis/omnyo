---
name: desktop-helper
description: Inspect the stopped Mac Desktop Helper feasibility experiment and its observed permission-attribution failure.
---

This experiment is stopped and its plugin is disabled. An actual GUI-daemon status probe showed that macOS TCC attributes Accessibility and Screen Recording to the parent Node process, despite the helper's separate signed identity. Milestone 1 rejects this topology. Do not enable capture or request permissions through it. The plugin owner must decide the revised native launch and authentication contract before implementation resumes.

The source retains the bounded probe for evidence and explicit reproduction after scope review. It has no cursor-following session, prompt composer, or chat submission flow. The command reference below describes the rejected candidate; it is not an activation recommendation.

Every call names the enrolled capture Mac with `--host <host-id>`. Loading the plugin starts no native process or observer.

- `omnyo desktop-helper native --host <host-id> status` starts the signed helper, reads its console, identity, and permission state, then closes it.
- `omnyo desktop-helper native --host <host-id> request-permissions accessibility` invokes the Accessibility permission API. This rejected topology attributes access to Node.
- `omnyo desktop-helper native --host <host-id> request-permissions screen-capture` invokes the Screen Recording permission API. This rejected topology attributes access to Node.
- `omnyo desktop-helper native --host <host-id> probe` opens the signed synthetic fixture, creates a nonactivating helper panel, registers Control-Option-Space, reads the synthetic AX target, and captures only that fixture when permissions permit.
- `omnyo desktop-helper native --host <host-id> shutdown` cancels this worker's active probe and waits for its owned children to close.

Request permissions only for an authorized native test. Verify the exact app named by macOS. If macOS attributes a grant to Node, Terminal, Omnyo, or another parent, stop this topology and report the attribution. Never modify TCC records, strip quarantine, or change launch routes to bypass a refusal.

Each operation is bounded. JSON results include native events and actual child-exit state. A `needs-permission` result is incomplete native proof. Status, signature checks, and a GUI launch domain do not prove permission attribution or successful capture.

The typed server RPC is `native`, with input `{"hostId":"<host-id>","operation":{"command":"status"}}`, where `operation` is `{"command":"status"}`, `{"command":"probe"}`, `{"command":"shutdown"}`, or `{"command":"request-permissions","permission":"accessibility"}`. The second permission value is `screen-capture`. Call it through `omnyo plugin rpc call desktop-helper native --input-file FILE --json` or `api.sdk.plugins.callRpc` with the same contract.

The bridge accepts only your own signed local artifacts. Set these environment variables in the plugin host on the capture Mac: `OMNYO_DESKTOP_HELPER_ARTIFACTS` (absolute artifact directory), `OMNYO_DESKTOP_HELPER_TEAM_ID` (your Apple Developer team id) and optionally `OMNYO_DESKTOP_HELPER_BUNDLE_ID` (default `dev.omnyo.desktop-helper`). `pnpm native:build` also needs `OMNYO_DESKTOP_HELPER_SIGNING_IDENTITY`. It verifies the expected bundle, team, architecture, protocol, executable hash, and every manifest file before launch. This is a local experiment path, not a native installer or distribution channel.

No model call, chat message, screenshot upload, global keyboard listener, persistent capture stream, or automatic activation is part of this probe.

`pnpm test:native-signature` verifies the production signature-check invocation against both signed synthetic apps and rejects a different bundle or team. It requires the native artifacts first. Run `pnpm native:build` with the documented absolute output path before this explicit check. Artifact cleanup intentionally removes that prerequisite; this command is not a default test.
