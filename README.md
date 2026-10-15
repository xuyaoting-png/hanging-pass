<h1 align="center">Hanging Pass</h1>

<p align="center">A hand-built lanyard &amp; badge interaction for the web —<br />
Verlet rope physics · a scroll-driven coverflow morph · a real 3D twisted ribbon.</p>

<p align="center"><code>Astro</code> · <code>TypeScript</code> · <code>Three.js</code> · zero UI framework</p>

<!-- TODO 发布前：录一段 10 秒动图放这里（README 的门面）：
     ![demo](docs/demo.gif)  -->

## What it is

Two screens, one continuous interaction:

1. **Screen 1 — the badge.** A hanging ID badge on a woven lanyard. It is not an
   animation loop: the strap is a Verlet/PBD rope simulated at a fixed 120 Hz timestep,
   the clip and O-ring are rigid bodies riding the rope's tail, and the card
   hangs from them by a punched hole. Drag it, let go, and it swings.
2. **Screen 2 — the cards.** Scrolling morphs the badge into a coverflow row of
   cards. Each card flips on a short click, and the strap keeps printing along
   its length while the cards drift.

Everything is plain TypeScript and CSS — no React, no GSAP, no animation library.

## What's inside

| System | File | What it does |
| --- | --- | --- |
| Rope | `src/scripts/lanyard-physics.ts` | Verlet chain + PBD constraints, gravity from a target period, grab/drag/release, entrance swing |
| Badge render | `src/scripts/lanyard-pass.ts` | Projects the rope into SVG: strap, clip plate, O-ring, punched hole; entrance animation; drag handling |
| Morph | `src/scripts/lanyard-morph.ts` | Scroll-driven coverflow, panel wiring, click-to-flip, auto-drift carousel, the runway that stages the transition |
| 3D ribbon | `src/scripts/strap-ribbon3d.ts` | The strap as a real 3D ribbon in Three.js: 72 quads, width·cos θ / width·sin θ, canvas-printed texture, self-occlusion by the z-buffer |
| Print glyphs | `src/scripts/strap-glyphs.ts` | A 5×7 bitmap font (A–Z, digits, `.`) for the woven print |

`src/scripts/strap-ribbon.ts` holds the 2D fallback geometry for the strap
(kept in the repo because the 2D path is still used for the outline and the
`prefers-reduced-motion` variant).

## Quick start

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
```

Requires **Node 22.12 or newer** — Astro 7 refuses to run on older Node, and CI will
fail with a version error rather than a helpful build error. No other services,
no build-time data.

## Make it yours

| What | Where |
| --- | --- |
| Card titles, chapters, back copy | `src/data/cards.demo.ts` |
| Badge text (name, line, motto, back headline) | `src/pages/index.astro` (search for `Your Name`) |
| Strap print (front / back) | `src/scripts/lanyard-pass.ts` — `LABEL_TEXT` and the `{ front, back }` argument to `setViewport` |
| Card covers | put images in `public/img/` and set `front.image` per card; they render full-bleed with the title on top |
| Colours, type, spacing | `src/styles/tokens.css` |
| Font | Geist is self-hosted in `public/fonts/` — see [`public/fonts/README.md`](public/fonts/README.md), or swap it for a system stack |

## Notes on behaviour (by design)

- **Reduced motion is respected.** With `prefers-reduced-motion: reduce` the
  entrance swing, the auto-drift carousel and the morph tweens are disabled.
- **The carousel only auto-advances while the pointer is over the card row**
  (`AUTO.onHover` in `lanyard-morph.ts`). Set `AUTO.always = true` to let it run
  unattended. A click pauses it, and the pause expires after 9 s
  (`AUTO.resumePauseAfterMs`) so it never gets stuck.
- **Dragging never selects text.** The drag surfaces set `user-select: none`
  (the side panel keeps `user-select: text`, so its links stay copyable).
- **Three.js costs ~138 KB gzip.** It is the only runtime dependency. If you
  don't need the 3D ribbon, `strap-ribbon.ts` renders the same strap in SVG.

## Browser support

Chromium, Safari and Firefox, current versions. The physics uses `requestAnimationFrame`
with a fixed timestep, so motion speed does not change with frame rate. WebGL 2
is used for the ribbon; the SVG strap remains as the fallback path.

## 中文说明

这是一个**零框架**的「悬挂工牌 + 卡片轮播」交互模板：第一屏是物理吊绳上的工牌
（Verlet 绳 + 刚体夹片/圆环，固定 120Hz 步长），第二屏是滚动形变出来的 coverflow 卡片，
吊绳本身是一条**真正的 3D 缎带**（Three.js，带自遮挡与印花贴图）。

- 卡片内容改 `src/data/cards.demo.ts`；牌子上的文字改 `src/pages/index.astro`
- 吊绳印花文案改 `src/scripts/lanyard-pass.ts` 里的 `LABEL_TEXT` 与 `{ front, back }`
- 已处理 `prefers-reduced-motion`；拖拽时不会选中文字

## License

MIT — see [LICENSE](LICENSE). Bundled font: Geist (see `public/fonts/README.md`).
