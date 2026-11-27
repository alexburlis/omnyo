# Native APFS sharing

`worktree-share.c` builds a standalone macOS executable with the system C
libraries. It needs no package manager or runtime compiler on an enrolled host.

Build from the repository root:

```sh
clang -std=c11 -O2 -Wall -Wextra -Werror -mmacosx-version-min=15.0 \
  plugins/environment-git-worktree/native/worktree-share.c -o <scratch>/worktree-share
```

To refresh the signed universal helper embedded in the host bundle, run
`node plugins/environment-git-worktree/scripts/build-share-helper.mjs "<Developer ID Application identity>"`
on a Mac with that signing identity. Commit the regenerated payload with the
source. The payload records SHA-256 digests for the C source and the executable.

## Protocol

`worktree-share --probe /absolute/existing/directory` checks the macOS version
and APFS mount without writing files. It exits with 0 for the supported platform,
2 for an unsupported platform, and 1 for an invalid or inaccessible directory.
The write operation also proves the required kernel behavior before accepting
input. A successful read-only probe alone does not prove that behavior.

`worktree-share /absolute/private/staging` reads alternating absolute donor and
destination paths from standard input, each terminated by NUL. EOF ends the
operation. The staging directory must already exist, belong to the current user,
have no group or other permissions, and share the destination's APFS volume.
Keep that directory stable across retries so recovery can run first.

Standard output contains one aggregate after an admitted operation:

```json
{"sharedFiles":1,"privateBytesReleased":1048576,"skippedFiles":0}
```

Exit 0 means the operation settled. Exit 2 means APFS, macOS, or the kernel
protection is unsupported. Exit 1 means an input, I/O, admission, or recovery
error. Rejection before admission can leave standard output empty. Standard
error contains at most twelve short diagnostics and never contains file contents.
SIGTERM and SIGINT stop input admission and settle the current batch. Do not
escalate a cancelled operation to SIGKILL.

## File integrity

The helper opens paths without following symlinks and checks file identities.
It skips hard links, compressed files, immutable files, foreign-owned files,
files writable by another Unix class, different contents, and different volumes.
The caller owns worktree selection, registration checks, and exclusion of active
environments and nested repositories.

The helper clones the donor into staging, verifies the cloned bytes, copies the
destination's metadata, and verifies the bytes and metadata again. It preserves
ownership, mode, flags, ACLs, xattrs, and native birth, modification, access, and
backup timestamps. Replacement changes the inode and ctime.

An atomic exchange moves the original into private staging. Before deleting the
original, the helper creates a temporary hard-link witness in that same private
directory, closes its own original descriptor, and removes the witness with
`AT_NODELETEBUSY`. A busy descriptor or mapping prevents that removal. After the
kernel confirms quiescence, the helper reopens and rechecks the retained original.
This second comparison catches a writer that wrote and closed after the first
comparison. The final original removal also uses `AT_NODELETEBUSY`. Rollback uses
the same witness and comparison for the displaced replacement.

At startup, disposable files inside staging prove this behavior for an open
writable descriptor, a shared writable mapping whose descriptor was closed, and
a file with no remaining consumer. Unsupported behavior prevents all input-file
changes. This does not depend on enumerating unrelated processes.

The source donor is never replaced. The helper restores its access timestamp
after reading. A successful exchange counts the difference between the original
and replacement's native private data sizes. This number does not claim a change
to volume free space or account for APFS snapshots.

## Recovery and verification

Each pending exchange has a durable record in an owned `pair-*` directory.
Recovery verifies the registered parent and file identities and either restores
the original or leaves both copies. An ambiguous or still-busy copy remains in
staging and returns an error. A crash after final removal only requires retiring
the owned journal. Do not delete a recovery directory to bypass that error.

Run the native fixtures from the repository root:

```sh
python3 plugins/environment-git-worktree/native/test_worktree_share.py \
  /absolute/disposable/native-test-directory
```

The fixtures use real APFS files and the production executable. A second build
adds only deterministic crash, cancellation, and concurrent-write injection.
Neither build filters processes or bypasses the kernel protection. The fixture
runner removes its generated binaries and case directories when it exits.

The clone, metadata-copy, and atomic-exchange design was informed by
[apfs-dedupe at 327ccd79](https://github.com/curlewlabs-com/apfs-dedupe/tree/327ccd79f1104a7e828892e6fa887c209aaf720b).
This C implementation does not copy upstream source. Darwin interface semantics
were checked against the system SDK and Apple's public XNU source.
