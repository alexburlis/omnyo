# Worker update checkpoint process proof

This isolated smoke drives the real Omnyo launcher, worker application, agent
runtime, scripted provider bridge, updater installer, accepted-session routes,
and migrated SQLite database. It never touches the enrolled machine carrying the
agent session or invokes a paid provider.

Preparation creates two fixture packages from the selected source: protocol N
and N+1, with synthetic versions `99.0.0+private.1` and `99.0.1+private.1`.
The only protocol-source variation is the constant in `protocol.ts`. Native
dependencies resolve to the existing selected checkout and Node runtime; the
manifest records those bindings. This is an isolated process proof, not a
portable release-artifact or desktop acceptance test.

Use a new disposable preparation directory and a new evidence directory outside
it. Keep each preparation invocation and the prepared smoke within 60 seconds.
The runner rejects changed source and artifact bytes before starting the smoke.

```bash
node tests/qa/worker-update-checkpoint/proof.mjs prepare /tmp/omnyo-checkpoint-prepared /absolute/source/checkout
node tests/qa/worker-update-checkpoint/proof.mjs run /tmp/omnyo-checkpoint-prepared /absolute/retained/evidence
node tests/qa/worker-update-checkpoint/proof.mjs cleanup /tmp/omnyo-checkpoint-prepared
```

The smoke installs N into its own npm prefix with the real npm installer and
starts `omnyo-app host-daemon --supervise`. A real scripted bridge creates an active
turn and user question using a client intent recorded through the coordinator's
existing event writer. The fixture coordinator then changes from N to N+1 on the
same loopback address. After the actual session rejection, the fixture emits a
known output delta through the production event sink and kills only its own
scripted bridge process. That real exit produces the pending terminal and
interaction records.

The existing updater downloads its bound N+1 tarball and installs it into the
same isolated prefix. The existing launcher restarts the daemon. The receipt
requires a new worker instance at N+1, restored thread identities in its first
handshake, ordered output and terminal events in the real database, precise
interaction settlement, the expected installed artifact digest, and retirement
of the acknowledged checkpoint. The coordinator deliberately replaces one
successful post-commit event response with a retryable transport error; replay
must leave one stored output record.

`receipt.json` and process logs stay in the evidence directory. The runtime's
prefix, database, provider state, and data directory are owned temporary scratch
and are removed in `finally` after the owned processes stop. Preparation failures
also remove their owned partial artifacts. Run `cleanup` only after all consumers
of that prepared directory have stopped. It verifies the producer marker and
directory absence. Keep the compact evidence and its owner-local retention
receipt under the normal storage policy.

The fixture supplies synthetic inputs and an acknowledgment fault. It does not
mock the installer, launcher restart, checkpoint owner, database append, or
session protocol rejection. It does not establish exactly-once downstream
follow-ups or survival of a general server crash.
