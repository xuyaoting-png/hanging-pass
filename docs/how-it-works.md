# How it works

Three systems stacked on top of each other. This document is the map: what each
one is responsible for, the numbers that matter, and the traps worth knowing
before you change them.

---

## 1. The rope — `lanyard-physics.ts`

A hanging badge is a chain, so it is simulated as one: a series of points
integrated with Verlet, then constrained.

**Integration.** Positions are advanced with

```
next = position + (position − previous) · friction + gravity · dt²
```

`frictionPerFrame` (0.9915) is the whole "how long does it keep swinging" knob.
Gravity is not a constant: it is derived from `TARGET_PERIOD` (1.86 s) so the
pendulum's natural period matches the reference hardware's feel regardless of
the rope's pixel length.

**Constraints.** After integration, 24 PBD iterations run per step:

| Constraint | Value | Keeps |
| --- | --- | --- |
| Segment length | `chainInvMass 0.06` | the rope at constant length |
| Bend | `bendStiffness 0.45` | the strap from folding into a `S`; raise it to make the webbing stiffer, lower it to make it floppier |
| Return to centre | `returnStrength 12` | the badge drifting off to one side |

**Fixed timestep.** The loop accumulates real time and steps at `1/120 s`. This
matters: with a variable `dt` the swing amplitude changes with frame rate, and
at very low frame rates the accumulated impulse can yank the card off the clip.

**Grab / drag / release.** While dragging, the grabbed point follows the pointer
and the rest of the chain follows through the constraints. On release the last
pointer delta becomes the point's velocity, so the badge carries the throw.
Two guards live here:

- the dragged point's centre of mass is clamped to `cordLength` from the clip,
  otherwise a fast drag separates the card from the strap;
- a drag that moved more than 6 px is *not* a click (`badge.dataset.wasDrag`),
  because browsers still fire `click` after a drag — that flag is what stops a
  drag from flipping the card.

---

## 2. The badge render — `lanyard-pass.ts`

The rope is simulated in a fixed scene coordinate space (the "rig"), then drawn.

**Projection.** The rope's polyline is turned into an SVG path for the strap,
and the tail's angle drives the clip plate's rotation. Ordering matters:
the clip is rotated by `tailAngle − 90 + rigTwist`, not the other way round —
inverted, the strap visibly leaves the plate's mouth.

**The hardware.** Flat rectangular plate (46 × 34) with a horizontal slot, a
small hole at the bottom, and an O-ring passing through it into the card's
punched hole. No rivets: the reference hardware has none, and adding them was
the single most-noticed wrong detail during development.

**Entrance.** On load the badge gets one impulse — `ENTRANCE = { ropeStretch,
angle, omega }` — scaled by `ropeScale`. That scale exists to stop a tall
viewport from over-driving the solver, but it also *silently halves the visible
swing* on tall windows, so it now has a floor (0.62). If the entrance looks
weak, that constant is the first thing to check.

**Flip.** The card flips on a short click (a drag does not flip). The flip is a
`rotateY` on the card only; the clip and ring scale down with
`flipScale = max(0.12, |cos(flipAngle)|)` so they don't poke through the card.

---

## 3. The morph — `lanyard-morph.ts`

One scroll position drives everything: `progress` 0 → 1 maps screen 1 to
screen 2. `panelProgress` is the second screen's own sub-progress, and the
carousel is only interactive once it passes ~0.85.

- **Coverflow.** Cards are laid out by a signed distance from the active index;
  the transform is a translate + scale + z-depth. `slideCount` is the number of
  *content* cards — the cover is deliberately excluded, because the badge flies
  out of the row during the morph.
- **The badge's exit.** `strapProgress` drives the strap's opacity/translate and
  the rig's `visibility`; the 3D ribbon canvas is registered in the same loop.
  **If you add another drawing layer, register it here** — a layer that isn't in
  this loop keeps rendering on screen 2. That exact bug shipped once.
- **Click vs drag.** A short click flips the centred card; a drag (>6 px) moves
  the carousel and never flips.
- **Auto-drift.** `AUTO = { onHover: true, always: false, secondsPerCard: 7,
  resumePauseAfterMs: 9000 }`. The pause flag is set by a click, a dot click or
  a drag, and clearing it *only* when the pointer leaves the row used to be
  enough to make the carousel look broken — hence the 9 s expiry.

---

## 4. The 3D ribbon — `strap-ribbon3d.ts`

The strap twists. Doing that convincingly in SVG means faking occlusion, so the
strap is a real 3D ribbon instead.

- **Geometry.** 72 segments × 2 vertices. Each segment's half-width is split
  into a `w·cos θ` in-plane component and a `w·sin θ` depth component, with θ
  from `twistEnvelope(flipAngle, 180)`. The z-buffer then handles self-occlusion
  for free — where the ribbon crosses itself you see the near face.
- **Winding matters.** Triangle winding must put the front face toward the
  camera (`indices.push(a, a+2, a+1, ...)`), otherwise `FrontSide` faces away
  and the viewer sees the *back* texture at rest.
- **Texture, not decals.** The print is painted into a 2D canvas and used as a
  `CanvasTexture`:
  - `TEX_SCALE` must be the same on **both axes** (the texture height is
    `bandWidth × TEX_SCALE`), or the glyphs come out stretched;
  - `magFilter` **and** `minFilter` are `NearestFilter` — mipmaps turn pixel
    print into mush as soon as the texture is minified;
  - **the texture's `u` axis is already "along the strap"**, so the glyphs are
    drawn directly in that space. Adding a `ctx.rotate` on top mirrors them;
  - the print repeats, and the runs are **laid out backwards from the clip end**
    so a whole word always sits on the visible part; the last `CLIP_RESERVE_CSS`
    px are left blank so the metal clip never covers a letter.
- **Sizing is driven by measurement, not estimates.** The font size is
  `min(bandWidth × CROSS_RATIO, visibleLength × 0.75)` and the texture length is
  the **mesh's own arc length**, re-measured and re-painted when it drifts more
  than 8%. Using an arc measured anywhere else compressed the print and doubled
  its apparent density.

---

## Debugging this thing

Two tricks that saved hours, and are worth copying:

- **`?debug=1`** forces a frame every tick and renders internal state
  (`getDebugState()`), which also keeps the animation loop alive in a throttled
  or headless browser. Without it, the fixed-timestep clamp (`1/30`) turns the
  carousel into slow motion and everything looks broken.
- **Export the canvases.** The print texture is an ordinary 2D canvas, so
  `toDataURL()` shows you exactly what was painted. The WebGL layer can be
  exported too if the renderer is created with `preserveDrawingBuffer: true`.
  When a screenshot API is unavailable, this is how you actually *see* the bug
  instead of guessing from numbers.
