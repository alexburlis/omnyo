import argparse
import hashlib
import json
import os
import pathlib
import plistlib
import subprocess

TEAM = os.environ.get("OMNYO_DESKTOP_HELPER_TEAM_ID", "")
BUNDLE_ID = os.environ.get("OMNYO_DESKTOP_HELPER_BUNDLE_ID", "dev.omnyo.desktop-helper")


def verify(directory, name, bundle_id):
    manifest = json.loads((directory / name).read_text())
    assert manifest["schema"] == 1 and manifest["protocol"] == 1
    assert manifest["bundleId"] == bundle_id and manifest["teamId"] == TEAM
    assert manifest["architecture"] == "arm64"
    app = directory / manifest["app"]
    assert app.name in ["Omnyo Desktop Helper.app", "Omnyo Desktop Helper Fixture.app"]
    assert app.is_dir() and not app.is_symlink()
    actual = {}
    for path in sorted(app.rglob("*")):
        assert not path.is_symlink(), "Symlink in native artifact"
        if path.is_file():
            actual[str(path.relative_to(app))] = {"path": str(path.relative_to(app)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size}
    declared = {entry["path"]: entry for entry in manifest["files"]}
    assert len(declared) == len(manifest["files"])
    assert actual == declared, "Native manifest does not match all signed bytes"
    assert manifest["executableSha256"] == actual["Contents/MacOS/OmnyoDesktopHelper"]["sha256"]
    plist = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    assert plist["CFBundleIdentifier"] == bundle_id
    assert plist["OmnyoDesktopHelperProtocol"] == 1 and plist["LSUIElement"] is True
    for command in [["/usr/bin/codesign", "--verify", "--strict", "--deep", str(app)],
                    ["/usr/bin/lipo", "-verify_arch", "arm64", str(app / "Contents" / "MacOS" / "OmnyoDesktopHelper")]]:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=10)
    signing = subprocess.run(["/usr/bin/codesign", "-dvv", str(app)], check=True, capture_output=True, text=True, timeout=10)
    assert f"TeamIdentifier={TEAM}" in signing.stderr and f"Identifier={bundle_id}" in signing.stderr
    return {"app": str(app), "bundleId": bundle_id, "teamId": TEAM, "protocol": 1,
            "files": len(actual), "executableSha256": manifest["executableSha256"], "status": "verified-signed-bytes"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-directory", required=True)
    args = parser.parse_args()
    if not TEAM:
        raise SystemExit("Set OMNYO_DESKTOP_HELPER_TEAM_ID to the signing team id")
    directory = pathlib.Path(args.artifact_directory)
    assert directory.is_absolute()
    results = [verify(directory, "native-manifest.json", BUNDLE_ID),
               verify(directory, "fixture-manifest.json", f"{BUNDLE_ID}.fixture")]
    print(json.dumps({"schema": 1, "status": "passed", "scope": "signed artifact integrity only; no GUI, permissions, AX or capture executed", "results": results}))


if __name__ == "__main__":
    main()
