import json
import re
import subprocess
import sys
from pathlib import Path

TARGET_LUFS = -17.8
CEILING_DBTP = -1.0
TOLERANCE = 0.3

directory = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "assets" / "sounds"


def measure(path: Path) -> tuple[float, float]:
    result = subprocess.run(
        ["ffmpeg", "-nostats", "-i", str(path), "-af", "apad=whole_dur=0.5,ebur128=peak=true", "-f", "null", "-"],
        capture_output=True,
        text=True,
        check=True,
    ).stderr
    momentary = [float(value) for value in re.findall(r"M:\s*(-?\d+(?:\.\d+)?)", result)]
    peaks = re.findall(r"Peak:\s*(-?\d+(?:\.\d+)?|-inf)\s*dBFS", result)
    return max(momentary), float(peaks[-1])


def stream(path: Path) -> dict:
    output = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return json.loads(output)["streams"][0]


def render(source: Path, destination: Path, gain: float, limit: bool) -> None:
    info = stream(source)
    filters = [f"volume={gain:.2f}dB"]
    if limit:
        filters.append("alimiter=limit=0.8:attack=1:release=40:level=disabled")
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(source), "-af", ",".join(filters),
            "-ar", str(info["sample_rate"]), "-ac", str(info["channels"]), "-c:a", "pcm_s16le", str(destination),
        ],
        check=True,
    )


report = []
for path in sorted(directory.glob("*.wav")):
    before, peak = measure(path)
    original = path.with_suffix(".source.wav")
    path.rename(original)
    gain = TARGET_LUFS - before
    limit = False
    for _ in range(4):
        render(original, path, gain, limit)
        after, peak_after = measure(path)
        if peak_after > CEILING_DBTP and not limit:
            limit = True
            continue
        if abs(after - TARGET_LUFS) <= TOLERANCE:
            break
        gain += TARGET_LUFS - after
    after, peak_after = measure(path)
    if peak_after > CEILING_DBTP:
        limit = False
        gain = min(gain, CEILING_DBTP - 0.1 - peak)
        render(original, path, gain, limit)
    original.unlink()
    after, peak_after = measure(path)
    report.append({"file": path.name, "before": before, "after": after, "truePeak": peak_after, "limited": limit})

print(json.dumps(report, indent=1))
