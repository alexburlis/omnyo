import ctypes
import json
import mmap
import os
from pathlib import Path
import pwd
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time


SOURCE = Path(__file__).with_name("worktree-share.c").resolve()
ROOT = Path(sys.argv[1]).resolve()
ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
LIBC = ctypes.CDLL(None, use_errno=True)


def set_xattr(path, name, value):
    assert LIBC.setxattr(os.fsencode(path), name.encode(), value, len(value), 0, 0) == 0


def get_xattr(path, name):
    size = LIBC.getxattr(os.fsencode(path), name.encode(), None, 0, 0, 0)
    assert size >= 0
    result = ctypes.create_string_buffer(size)
    assert LIBC.getxattr(os.fsencode(path), name.encode(), result, size, 0, 0) == size
    return result.raw


def list_xattr(path):
    size = LIBC.listxattr(os.fsencode(path), None, 0, 0)
    assert size >= 0
    result = ctypes.create_string_buffer(size)
    assert LIBC.listxattr(os.fsencode(path), result, size, 0) == size
    return [part.decode() for part in result.raw.split(b"\0") if part]


class AttrList(ctypes.Structure):
    _fields_ = [("count", ctypes.c_ushort), ("reserved", ctypes.c_ushort)] + [
        (name, ctypes.c_uint32) for name in ("common", "volume", "directory", "file", "fork")
    ]


def attribute(path, field):
    attrs = AttrList(5, 0, 0, 0, 0, 0, field)
    result = ctypes.create_string_buffer(12)
    fd = os.open(path, os.O_RDONLY)
    try:
        assert LIBC.fgetattrlist(fd, ctypes.byref(attrs), result, 12, 0x20) == 0
        return struct.unpack("=IQ", result.raw)[1]
    finally:
        os.close(fd)


def native_times(path, set_value=None):
    attrs = AttrList(5, 0, 0x200 | 0x400 | 0x1000 | 0x2000, 0, 0, 0, 0)
    fd = os.open(path, os.O_RDONLY)
    try:
        if set_value is not None:
            raw = ctypes.create_string_buffer(struct.pack("=qqqqqqqq", *set_value))
            assert LIBC.fsetattrlist(fd, ctypes.byref(attrs), raw, 64, 0) == 0
        result = ctypes.create_string_buffer(68)
        assert LIBC.fgetattrlist(fd, ctypes.byref(attrs), result, 68, 0) == 0
        return struct.unpack("=Iqqqqqqqq", result.raw)[1:]
    finally:
        os.close(fd)


def build():
    binary = ROOT / "worktree-share"
    controlled = ROOT / "worktree-share-fixture"
    driver = ROOT / "fixture.c"
    driver.write_text(
        '#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\n'
        '#include <signal.h>\n#include <string.h>\n#include <dirent.h>\n#include <fcntl.h>\n'
        'static void fixture_write(const char *text) { '
        'DIR *d = opendir(getenv("FIXTURE_STAGE")); struct dirent *e; '
        'while ((e = readdir(d))) { if (strncmp(e->d_name, "pair-", 5)) continue; '
        'int p = openat(dirfd(d), e->d_name, O_RDONLY | O_DIRECTORY); '
        'int f = openat(p, "file", O_WRONLY); if (f < 0) _exit(92); '
        'if (pwrite(f, text, strlen(text), 0) < 0) _exit(93); close(f); close(p); } closedir(d); }\n'
        'static void fixture_phase(const char *phase) { '
        'const char *race = getenv("FIXTURE_RACE"); '
        'if (race && !strcmp(phase, "before-settle")) fixture_write("original-written-and-closed"); '
        'if (race && !strcmp(race, "both") && !strcmp(phase, "after-rollback")) '
        'fixture_write("clone-written-and-closed"); '
        'const char *p = getenv("FIXTURE_PHASE"); if (!p || strcmp(p, phase)) return; '
        'if (getenv("FIXTURE_TERM")) raise(SIGTERM); else _exit(91); }\n'
        '#define WORKTREE_SHARE_PHASE(phase) fixture_phase(phase)\n'
        f'#include "{SOURCE}"\n'
    )
    for source, output in ((SOURCE, binary), (driver, controlled)):
        subprocess.run(
            ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
             str(source), "-o", str(output)],
            check=True,
        )
    return binary, controlled


BINARY, CONTROLLED = build()
passed = []


def case(name, run):
    folder = Path(tempfile.mkdtemp(prefix=name + "-", dir=ROOT))
    try:
        source, target, stage = folder / "source", folder / "target", folder / "stage"
        stage.mkdir(mode=0o700)
        data = os.urandom(1024 * 1024)
        source.write_bytes(data)
        target.write_bytes(data)
        run(folder, source, target, stage, data)
        passed.append(name)
        print("PASS", name, flush=True)
    finally:
        shutil.rmtree(folder)


def invoke(stage, pairs=(), production=False, **extra):
    payload = b"".join(os.fsencode(path) + b"\0" for pair in pairs for path in pair)
    env = os.environ.copy()
    env.update(extra)
    result = subprocess.run([str(BINARY if production else CONTROLLED), str(stage)],
                            input=payload, capture_output=True, env=env, timeout=30)
    outcome = json.loads(result.stdout) if result.stdout else None
    return result, outcome


def clean(stage):
    assert sorted(p.name for p in stage.iterdir()) == [".lock"]


def sharing(folder, source, target, stage, data):
    os.chmod(target, 0o750)
    os.chflags(target, stat.UF_HIDDEN | stat.UF_NODUMP)
    user = pwd.getpwuid(os.getuid()).pw_name
    subprocess.run(["chmod", "+a", f"user:{user} allow read,readattr,readextattr,readsecurity", str(target)], check=True)
    acl = subprocess.check_output(["ls", "-le", str(target)]).splitlines()[1:]
    set_xattr(target, "com.omnyo.fixture", b"destination metadata")
    set_xattr(source, "com.omnyo.donor-only", b"must disappear")
    os.utime(target, ns=(1600000000123456789, 1600000000987654321))
    times = native_times(target, (1590000000, 123456789, 1600000000, 987654321,
                                 1600000000, 123456789, 1580000000, 987654321))
    before = target.stat()
    private = attribute(target, 0x8)
    result, summary = invoke(stage, [(source, target)])
    assert result.returncode == 0, result.stderr
    assert summary == {"sharedFiles": 1, "privateBytesReleased": private, "skippedFiles": 0}, summary
    after = target.stat()
    assert before.st_ino != after.st_ino
    assert (before.st_mode, before.st_uid, before.st_gid, before.st_mtime_ns, before.st_atime_ns) == (
        after.st_mode, after.st_uid, after.st_gid, after.st_mtime_ns, after.st_atime_ns)
    assert before.st_flags == after.st_flags
    assert native_times(target) == times
    assert subprocess.check_output(["ls", "-le", str(target)]).splitlines()[1:] == acl
    assert list_xattr(target) == ["com.omnyo.fixture"], list_xattr(target)
    assert get_xattr(target, "com.omnyo.fixture") == b"destination metadata"
    assert attribute(target, 0x8) == 0
    assert attribute(source, 0x100) == attribute(target, 0x100) != 0
    inode = after.st_ino
    result, summary = invoke(stage, [(source, target)])
    assert result.returncode == 0 and summary["sharedFiles"] == 0, (result.stderr, summary)
    assert target.stat().st_ino == inode
    with target.open("r+b") as handle:
        handle.write(b"target")
    assert source.read_bytes() == data
    with source.open("r+b") as handle:
        handle.seek(20)
        handle.write(b"source")
    assert target.read_bytes()[20:26] == data[20:26]
    clean(stage)


def mismatch(folder, source, target, stage, data):
    target.write_bytes(b"different" * 100)
    before = target.stat().st_ino
    result, summary = invoke(stage, [(source, target)])
    assert result.returncode == 0 and summary["sharedFiles"] == 0
    assert target.read_bytes() == b"different" * 100 and target.stat().st_ino == before
    clean(stage)


def links(folder, source, target, stage, data):
    linked = folder / "hard"
    os.link(target, linked)
    result, summary = invoke(stage, [(source, target)])
    assert result.returncode == 0 and summary["sharedFiles"] == 0
    symlink = folder / "symlink"
    symlink.symlink_to(source)
    result, summary = invoke(stage, [(source, symlink)])
    assert result.returncode == 0 and summary["sharedFiles"] == 0 and symlink.is_symlink()
    clean(stage)


def writer(folder, source, target, stage, data):
    inode = target.stat().st_ino
    with target.open("r+b") as handle:
        result, summary = invoke(stage, [(source, target)])
        assert result.returncode == 0 and summary["sharedFiles"] == 0, (result.stderr, summary)
        handle.seek(0)
        handle.write(b"held writer")
    assert target.stat().st_ino == inode and target.read_bytes().startswith(b"held writer")
    clean(stage)


def special_files(folder, source, target, stage, data):
    fifo = folder / "pipe"
    os.mkfifo(fifo)
    result, summary = invoke(stage, [(source, fifo), (fifo, target)])
    assert result.returncode == 0 and summary["skippedFiles"] == 2, (result.stderr, summary)
    assert stat.S_ISFIFO(fifo.stat().st_mode) and target.read_bytes() == data
    clean(stage)


def mapping(folder, source, target, stage, data):
    descriptor = os.open(target, os.O_RDWR)
    mapped = mmap.mmap(descriptor, 0)
    os.close(descriptor)
    try:
        inode = target.stat().st_ino
        result, summary = invoke(stage, [(source, target)])
        assert result.returncode == 0 and summary["sharedFiles"] == 0, (result.stderr, summary)
        mapped[:6] = b"mapped"
        mapped.flush()
        assert target.stat().st_ino == inode and target.read_bytes().startswith(b"mapped")
    finally:
        mapped.close()
    clean(stage)


def interrupted(phase):
    def run(folder, source, target, stage, data):
        result, _ = invoke(stage, [(source, target)], FIXTURE_PHASE=phase)
        assert result.returncode == 91
        assert target.read_bytes() == data
        result, summary = invoke(stage)
        assert result.returncode == 0 and summary["sharedFiles"] == 0, (result.stderr, summary)
        assert target.read_bytes() == data
        clean(stage)
    return run


def ambiguous(folder, source, target, stage, data):
    result, _ = invoke(stage, [(source, target)], FIXTURE_PHASE="after-swap")
    assert result.returncode == 91
    target.write_bytes(b"new user data")
    result, _ = invoke(stage)
    assert result.returncode != 0 and target.read_bytes() == b"new user data"
    originals = list(stage.glob("pair-*/file"))
    assert len(originals) == 1 and originals[0].read_bytes() == data


def cancellation(folder, source, target, stage, data):
    result, summary = invoke(stage, [(source, target)], FIXTURE_PHASE="after-swap", FIXTURE_TERM="1")
    assert result.returncode == 0 and summary["sharedFiles"] == 1, (result.stderr, summary)
    assert target.read_bytes() == data
    clean(stage)


def late_write(folder, source, target, stage, data):
    result, summary = invoke(stage, [(source, target)], FIXTURE_RACE="original", FIXTURE_STAGE=str(stage))
    assert result.returncode == 0 and summary["sharedFiles"] == 0, (result.stderr, summary)
    assert target.read_bytes().startswith(b"original-written-and-closed")
    clean(stage)


def rollback_write(folder, source, target, stage, data):
    result, summary = invoke(stage, [(source, target)], FIXTURE_RACE="both", FIXTURE_STAGE=str(stage))
    assert result.returncode != 0 and summary["sharedFiles"] == 0, (result.stderr, summary)
    assert target.read_bytes().startswith(b"original-written-and-closed")
    retained = list(stage.glob("pair-*/file"))
    assert len(retained) == 1 and retained[0].read_bytes().startswith(b"clone-written-and-closed")


def malformed(folder, source, target, stage, data):
    result = subprocess.run([str(BINARY), str(stage)], input=b"/incomplete", capture_output=True)
    assert result.returncode == 1 and json.loads(result.stdout)["sharedFiles"] == 0
    assert target.read_bytes() == data
    clean(stage)


def cancelled_input(folder, source, target, stage, data):
    process = subprocess.Popen([str(BINARY), str(stage)], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 2
        while not (stage / ".lock").exists() and time.monotonic() < deadline:
            time.sleep(0.001)
        time.sleep(0.03)
        process.send_signal(signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=3)
        assert process.returncode == 0, stderr
        assert json.loads(stdout)["sharedFiles"] == 0
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=3)
    clean(stage)


def production(folder, source, target, stage, data):
    assert subprocess.run([str(BINARY), "--probe", str(folder)]).returncode == 0
    assert list(stage.iterdir()) == []
    inode = target.stat().st_ino
    result, summary = invoke(stage, [(source, target)], production=True)
    if result.returncode:
        print("PRODUCTION RESULT", summary, result.stderr.decode().strip(), flush=True)
        assert summary["sharedFiles"] == 0 and target.stat().st_ino == inode
        assert not list(stage.glob("pair-*"))
        print("PRODUCTION HELD:", result.stderr.decode().strip(), flush=True)
    else:
        assert summary["sharedFiles"] == 1
    assert target.read_bytes() == data
    clean(stage)


try:
    case("sharing-metadata-repeat-independent-writes", sharing)
    case("different-content", mismatch)
    case("hardlinks-symlinks", links)
    case("special-file-never-blocks", special_files)
    case("open-writer", writer)
    case("closed-descriptor-writable-mapping", mapping)
    for phase in ("before-swap", "after-swap", "after-witness", "after-quiesce", "after-release"):
        case("recovery-" + phase, interrupted(phase))
    case("recovery-preserves-two-changed-versions", ambiguous)
    case("sigterm-settles-exchange", cancellation)
    case("writer-closes-before-settlement", late_write)
    case("writer-closes-during-rollback", rollback_write)
    case("malformed-input", malformed)
    case("sigterm-interrupts-input-wait", cancelled_input)
    case("production-capability-and-inspection", production)
    print(json.dumps({"passed": passed, "count": len(passed)}))
finally:
    for artifact in (BINARY, CONTROLLED, ROOT / "fixture.c"):
        artifact.unlink(missing_ok=True)
