import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import signal
import shutil
import subprocess
import tempfile
import time


def required_environment(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Set {name} before building the native helper")
    return value


# Apple Developer team id and the code-signing identity (certificate hash or name) used to sign.
TEAM = required_environment("OMNYO_DESKTOP_HELPER_TEAM_ID")
IDENTITY = required_environment("OMNYO_DESKTOP_HELPER_SIGNING_IDENTITY")
BUNDLE_ID = os.environ.get("OMNYO_DESKTOP_HELPER_BUNDLE_ID", "dev.omnyo.desktop-helper")
ROOT = pathlib.Path(__file__).resolve().parents[1]
DEADLINE = time.monotonic() + 55


def run(arguments):
    process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=max(0.1, DEADLINE - time.monotonic()))
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=1)
        raise RuntimeError("Native build exceeded its 55-second bound; owned process group stopped")
    if process.returncode:
        raise RuntimeError(f"{pathlib.Path(arguments[0]).name} failed: {stderr[-4000:]}")
    return stdout


def manifest(app, bundle_id, build):
    files = []
    for path in sorted(app.rglob("*")):
        if path.is_symlink():
            raise RuntimeError("Native artifacts cannot contain symlinks")
        if path.is_file():
            files.append({"path": str(path.relative_to(app)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size})
    executable = next(entry for entry in files if entry["path"] == "Contents/MacOS/OmnyoDesktopHelper")
    return {"schema": 1, "protocol": 1, "bundleId": bundle_id, "teamId": TEAM,
            "architecture": "arm64", "build": build, "app": app.name,
            "executableSha256": executable["sha256"], "files": files}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--build", type=int, default=1)
    parser.add_argument("--component", choices=["helper", "fixture"], required=True)
    args = parser.parse_args()
    output = pathlib.Path(args.output)
    if not output.is_absolute() or args.build < 1:
        raise RuntimeError("Use a new absolute output directory and a positive build")
    if shutil.disk_usage(output.parent).free < 100 * 1024 * 1024:
        raise RuntimeError("Native probe needs 100 MiB free")
    output.mkdir(mode=0o700, exist_ok=True)
    component = ("Helper.swift", "Omnyo Desktop Helper", "") if args.component == "helper" else ("Fixture.swift", "Omnyo Desktop Helper Fixture", ".fixture")
    if (output / f"{component[1]}.app").exists():
        raise RuntimeError("Native component already exists; use a new output directory")
    started = time.monotonic()
    receipt = {"schema": 1, "purpose": "Desktop Helper milestone 1 native probe",
               "output": str(output), "expectedPeakBytes": 100 * 1024 * 1024,
               "restoreInputs": "desktop-helper/native and scripts/native-build.py",
               "status": "building", "compilerScratchRemoved": False}
    try:
        with tempfile.TemporaryDirectory(prefix="compiler-", dir=output) as compiler:
            for source, name, suffix in [component]:
                app = output / f"{name}.app"
                (app / "Contents" / "MacOS").mkdir(parents=True)
                bundle_id = f"{BUNDLE_ID}{suffix}"
                plist = {"CFBundleIdentifier": bundle_id, "CFBundleName": name, "CFBundleDisplayName": name,
                         "CFBundleExecutable": "OmnyoDesktopHelper", "CFBundlePackageType": "APPL",
                         "CFBundleShortVersionString": "0.1.0", "CFBundleVersion": str(args.build),
                         "LSMinimumSystemVersion": "14.0", "LSUIElement": True,
                         "NSPrincipalClass": "NSApplication", "OmnyoDesktopHelperProtocol": 1,
                         "NSAccessibilityUsageDescription": "Read the synthetic Desktop Helper target during the authorized native proof.",
                         "NSScreenCaptureUsageDescription": "Capture only the synthetic Desktop Helper fixture during the authorized native proof."}
                with (app / "Contents" / "Info.plist").open("wb") as stream:
                    plistlib.dump(plist, stream, sort_keys=True)
                run(["/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-Onone", "-target", "arm64-apple-macos14.0",
                     "-module-cache-path", str(pathlib.Path.home() / "Library/Developer/Xcode/DerivedData/ModuleCache.noindex"), str(ROOT / "native" / source), "-o", str(app / "Contents" / "MacOS" / "OmnyoDesktopHelper")])
                run(["/usr/bin/codesign", "--force", "--options", "runtime", "--timestamp", "--sign", IDENTITY, str(app)])
                run(["/usr/bin/codesign", "--verify", "--strict", "--deep", str(app)])
                payload = manifest(app, bundle_id, args.build)
                manifest_name = "fixture-manifest.json" if suffix else "native-manifest.json"
                (output / manifest_name).write_text(json.dumps(payload, indent=2) + "\n")
        receipt["compilerScratchRemoved"] = True
        receipt["status"] = "signed-local-candidate"
        receipt["elapsedSeconds"] = round(time.monotonic() - started, 3)
    except BaseException as error:
        receipt["status"] = "failed"
        receipt["failure"] = str(error)
        receipt["compilerScratchRemoved"] = not any(output.glob("compiler-*"))
        raise
    finally:
        (output / f"{args.component}-build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
