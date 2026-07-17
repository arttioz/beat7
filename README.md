# Beat7 — O2Jam-style rhythm game (WebGL)

Upload an MP3 → the game analyzes it (onset detection + BPM) → auto-generates a
note chart at Easy / Medium / Hard in 4K, 5K or 7K mode.

Keys: 4K `D F J K` · 5K `D F [Space] J K` · 7K `S D F [Space] J K L`

## Run

```sh
npm install
npm run dev
```

## Deploy

```sh
npm run build     # outputs static site to dist/
npm run preview   # test the built version locally
```

`dist/` is a fully static site (relative asset paths via `base: './'`), so it
works on any static host — Netlify / Vercel / GitHub Pages / S3 / nginx — at
the domain root **or** under a subpath. Just upload the `dist/` folder.

The default song (`public/default-song.mp3`) and hand-tuned default chart
(`public/default-chart.json`) are bundled and auto-load on startup. To change
them, replace those two files (the chart's `audioHash` must match the MP3 —
export a chart made for that song).

## Features

- **Audio analysis** (`src/analysis.ts`): spectral-flux onset detection in 3
  frequency bands (bass/mid/high), BPM via autocorrelation, beat-phase alignment.
- **Chart generation** (`src/generator.ts`): onsets snapped to the beat grid,
  density filtered per difficulty and key count, lanes assigned by frequency
  band with stair walkers, long notes on strong sustained bass.
- **Key modes**: 4, 5 or 7 lanes — charts carry their key count, and density /
  chord size scale down for the smaller modes.
- **Play modes**: 🧘 **Chill** — no power bar, no fail, just vibe. 🎤 **Audition** —
  an O2Jam-style rainbow power gauge on the side fills on hits and drains on
  misses; empty = dropped out. Keep a hot streak to hit the **GOLDEN BUZZER**:
  golden stage, gold confetti and 2× score for the rest of the song (notes keep
  their lane colors so they stay readable).
- **Gameplay** (`src/game.ts`): PixiJS (WebGL) rendering, judgment windows
  COOL ±45ms / GOOD ±90ms / BAD ±135ms, long notes, combo, 1M max score,
  grades SS–D. Timing is driven by `AudioContext.currentTime`.
- **Export / Import**: chart as JSON (`notes` are `[timeMs, lane, lengthMs]`
  tuples). Charts carry a SHA-256 of the audio file so mismatches are flagged.
- **Chart editor** (`src/editor.ts`): click to add notes (drag up = long note),
  drag to move, drag the tail handle to resize (shrink = back to tap),
  right-click / Delete to remove, Ctrl+Z undo, beat-grid snap (1/4 · 1/8 · 1/16),
  zoom, seek bar, 0.5x/0.75x slow-motion playback, and a **record mode** — play
  the song and press lane keys to lay notes at the press time (hold = long note).
- **AI rearrange (no API cost)**: *Copy AI prompt* → paste into Claude web or
  desktop → copy its JSON reply → *Paste AI result*. The reply goes through the
  same validator as file import, so a malformed reply can never break gameplay.
- **Built-in demo song** (`src/demo.ts`): synthesized 120 BPM track for testing
  without an MP3.
- Settings: scroll speed, audio offset, autoplay.
- **Tap-to-calibrate** (`src/calibrate.ts`): tap along with a metronome and the
  judgment offset is measured (median of 12 taps) and saved automatically —
  compensates audio output latency, display lag and keyboard latency in one go.
  Non-perfect hits show **EARLY/LATE** with the millisecond error so you can
  tell which way you're off.
