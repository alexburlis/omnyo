export const createScrollTimeline = () =>
  "ScrollTimeline" in window
    ? new ScrollTimeline({
        source: document.scrollingElement ?? document.documentElement,
        axis: "block",
      })
    : null;

export const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

export const ramp = (value: number, start: number, length: number) =>
  clamp01((value - start) / length);

export const smooth = (value: number) => value * value * (3 - 2 * value);

export const reach = (x: number, y: number, vw: number, vh: number) =>
  Math.max(
    Math.hypot(x, y),
    Math.hypot(vw - x, y),
    Math.hypot(x, vh - y),
    Math.hypot(vw - x, vh - y),
  );

export const wipeRadius = (
  wipeT: number,
  x: number,
  y: number,
  vw: number,
  vh: number,
) => (wipeT >= 1 ? reach(x, y, vw, vh) + 4 : wipeT * (reach(x, y, vw, vh) + 4));

export const discScale = (vr: number, radius: number) => (vr + 16) / radius;

export interface DiscTrack {
  start: number;
  length: number;
  center: (scroll: number) => { x: number; y: number };
}

export interface DiscFrame {
  scroll: number;
  scale: number;
}

export const DISC_RANGE = 200_000;

export const START_STEP = 0.5;

export const WIPE_STEP = 8;

export const TAIL_STEP = 64;

export const trackScale = (
  track: DiscTrack,
  scroll: number,
  vw: number,
  vh: number,
  radius: number,
) => {
  if (scroll <= track.start) return 0;
  const { x, y } = track.center(scroll);
  const wipeT = smooth(clamp01((scroll - track.start) / track.length));

  return discScale(wipeRadius(wipeT, x, y, vw, vh), radius);
};

export const discFrames = (
  track: DiscTrack,
  tail: number,
  vw: number,
  vh: number,
  radius: number,
  coverHeight = vh,
): DiscFrame[] => {
  const wipeCount = Math.max(1, Math.ceil(track.length / WIPE_STEP));
  const tailCount = Math.max(1, Math.ceil(tail / TAIL_STEP));
  const frames: DiscFrame[] = [{ scroll: track.start, scale: 0 }];

  const push = (distance: number) => {
    const scroll = track.start + distance;
    frames.push({ scroll, scale: trackScale(track, scroll, vw, vh, radius) });
  };

  push(Math.min(START_STEP, track.length / wipeCount / 2));

  for (let index = 1; index <= wipeCount; index++) {
    push((index / wipeCount) * track.length);
  }

  const cover = (distance: number) => {
    const scroll = track.start + track.length + distance;
    const { x, y } = track.center(scroll);

    frames.push({
      scroll,
      scale: discScale(
        wipeRadius(1, x, y, vw, Math.max(vh, coverHeight)),
        radius,
      ),
    });
  };

  cover(START_STEP);

  for (let index = 1; index <= tailCount; index++) {
    cover((index / tailCount) * tail);
  }

  return frames;
};

export const frameScaleAt = (frames: DiscFrame[], scroll: number) => {
  const after = frames.findIndex((frame) => frame.scroll >= scroll);

  if (after < 0) return frames.at(-1)?.scale ?? 0;
  const next = frames[after];
  const previous = frames[after - 1];

  if (!next || !previous) return next?.scale ?? 0;
  const mix = (scroll - previous.scroll) / (next.scroll - previous.scroll);

  return previous.scale + (next.scale - previous.scale) * mix;
};

export const rangeFrames = (frames: DiscFrame[]) => [
  { offset: 0, scroll: 0, scale: frameScaleAt(frames, 0) },
  ...frames
    .filter((frame) => frame.scroll > 0 && frame.scroll < DISC_RANGE)
    .map((frame) => ({
      offset: frame.scroll / DISC_RANGE,
      scroll: frame.scroll,
      scale: frame.scale,
    })),
  { offset: 1, scroll: DISC_RANGE, scale: frameScaleAt(frames, DISC_RANGE) },
];
