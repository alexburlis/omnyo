import subprocess
import sys

import numpy as np

source, output, gain_db = sys.argv[1], sys.argv[2], float(sys.argv[3])
rate = 44100

raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", source, "-f", "f32le", "-ac", "2", "-ar", str(rate), "-"],
    capture_output=True,
    check=True,
).stdout
audio = np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)

start = int(0.084 * rate)
end = int(0.410 * rate)
dry = audio[start:end].copy()

fade_in = int(0.002 * rate)
dry[:fade_in] *= np.linspace(0, 1, fade_in)[:, None]
fade_out = int(0.020 * rate)
dry[-fade_out:] *= np.cos(np.linspace(0, np.pi / 2, fade_out))[:, None] ** 2

tick_boost_db = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
boost = np.ones(len(dry))
ramp_start = int(0.105 * rate)
ramp_end = int(0.125 * rate)
boost[ramp_start:ramp_end] = np.linspace(1, 10 ** (tick_boost_db / 20), ramp_end - ramp_start)
boost[ramp_end:] = 10 ** (tick_boost_db / 20)
dry *= boost[:, None]

mixed = dry

mixed *= 10 ** (gain_db / 20)
raw_path = output + ".f32"
mixed.astype(np.float32).tofile(raw_path)
subprocess.run(
    [
        "ffmpeg", "-v", "error", "-y",
        "-f", "f32le", "-ar", str(rate), "-ac", "2", "-i", raw_path,
        "-af", "alimiter=limit=0.72:attack=1:release=40:level=disabled,volume=1.0",
        "-c:a", "pcm_s16le", output,
    ],
    check=True,
)
print("seconds", round(len(dry) / rate, 3))
