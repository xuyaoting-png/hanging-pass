/**
 * 3D twisted ribbon (WebGL / Three.js)
 *
 * Why real 3D: the 2D approximation can only "narrow + recolor" — it cannot do two things:
 *   ① the surface really turning to the side (face orientation changes → shading changes)
 *   ② the two strands at the knot occluding each other (front/back order)
 * Real 3D surface: the cross-section at each point rotates by θ(s) about the tangent; width
 * projects to w·cosθ, depth to w·sinθ → narrows edge-on, self-occludes at the knot; print
 * is a texture, so the text warps with the twist and mirrors automatically when flipped.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  BackSide,
  Mesh,
  FrontSide,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  NearestFilter,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { GLYPH_H, GLYPH_W, glyphRows } from './strap-glyphs';

export type Pt = { x: number; y: number };

/** Segments along the cord (higher = smoother, linear cost) */
const SEGMENTS = 72;
/** Texture resolution: **used for both axes** (texels / CSS px). Mismatch stretches glyphs */
const TEX_SCALE = 2.2;
/** Texture height = ribbon width × TEX_SCALE (proportional, must not be hard-coded) */
const texHeight = (ribbonWidth: number): number => Math.max(24, Math.round(ribbonWidth * TEX_SCALE));
/** Knot position (along the visible span 0..1) and the knot's angular width */
const KNOT_AT = 0.42;
const KNOT_WIDTH = 0.26;

export type Ribbon3D = {
  /** Rebuild textures and camera when the viewport/cord length changes */
  setViewport(width: number, height: number, ribbonLength: number, label: { front: string; back: string }, visibleLength: number): void;
  /** Per frame: rebuild geometry from the polyline and twist angle, then render */
  update(points: Pt[], twist: number): void;
  /** For verification: render stats */
  info(): { triangles: number; calls: number; pixel: number; runCss: number; gapCss: number; textureLength: number };
  dispose(): void;
};

/**
 * Seven-segment display: A top / B upper-right / C lower-right / D bottom / E lower-left /
 * F upper-left / G middle. Unlit segments are drawn at 8% opacity — that is the LCD look.
 */
const SEGMENTS_ON: Record<string, string> = {
  '0': 'ABCDEF',
  '1': 'BC',
  '2': 'ABDEG',
  '3': 'ABCDG',
  '4': 'BCFG',
  '5': 'ACDFG',
  '6': 'ACDEFG',
  '7': 'ABC',
  '8': 'ABCDEFG',
  '9': 'ABCDFG',
};

function paintSevenSegment(
  ctx: CanvasRenderingContext2D,
  digit: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const on = SEGMENTS_ON[digit] ?? '';
  const t = Math.max(1.6, w * 0.22);
  const bars: Record<string, [number, number, number, number]> = {
    A: [x + t * 0.5, y, w - t, t],
    B: [x + w - t, y + t * 0.5, t, h / 2 - t],
    C: [x + w - t, y + h / 2, t, h / 2 - t * 0.5],
    D: [x + t * 0.5, y + h - t, w - t, t],
    E: [x, y + h / 2, t, h / 2 - t * 0.5],
    F: [x, y + t * 0.5, t, h / 2 - t],
    G: [x + t * 0.5, y + h / 2 - t / 2, w - t, t],
  };
  ctx.fillStyle = 'rgba(244,247,241,0.08)';
  for (const bar of Object.values(bars)) ctx.fillRect(bar[0], bar[1], bar[2], bar[3]);
  ctx.fillStyle = '#f4f7f1';
  for (const key of on) {
    const bar = bars[key];
    if (bar) ctx.fillRect(bar[0], bar[1], bar[2], bar[3]);
  }
}

/**
 * Paint the webbing unwrap (base + weave + stitching + small text) into a canvas as texture.
 *
 * Approach A (full-bleed small text):
 *   · Size comes only from the **strap width** (a wrong span/arc estimate kills all text)
 *   · glyph cross width = strap width × 0.28
 *   · repeat along the cord as "one print run + 74 CSS px gap" to fill the strap
 *   · letters use bitmap glyphs, digits use the seven-segment display
 */
function paintTexture(
  canvas: HTMLCanvasElement,
  lengthPx: number,
  text: string,
  digits: boolean,
  ribbonWidth: number,
  visibleCss: number,
): { pixel: number; runCss: number; gapCss: number } {
  const w = Math.max(64, Math.round(lengthPx * TEX_SCALE));
  const h = texHeight(ribbonWidth);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { pixel: 0, runCss: 0, gapCss: 0 };

  // Base + baked horizontal shading (dark edges, bright mid → fabric roundness, no lighting)
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#4f5f52');
  base.addColorStop(0.28, '#66796b');
  base.addColorStop(0.5, '#6e8173');
  base.addColorStop(0.72, '#66796b');
  base.addColorStop(1, '#4f5f52');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Diagonal weave (kept faint so it does not fight the text)
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 2;
  for (let x = -h; x < w + h; x += 7) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h, h);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.045)';
  for (let x = -h + 3.5; x < w + h; x += 7) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + h, h);
    ctx.stroke();
  }
  ctx.restore();

  // Stitch lines on both edges
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  for (const y of [3.5, h - 3.5]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // ===== Full-bleed small text =====
  // Coordinate system: texture u = along the cord, v = across the cord.
  // So "the print looks rotated 90° on the strap" is **done by texture space itself** —
  // do not add ctx.rotate: it mirrors the text instead (one root cause of unreadable glyphs).
  const CROSS_RATIO = 0.36;   // glyph height (across cord) / strap width
  const GAP_CSS = 40;
  const CLIP_RESERVE_CSS = 58; // clip-plate margin: keep print clear of metal // gap between runs
  const cellsAlong = 5;       // glyph width (along cord) = 5 cells (letters and digits alike)
  // Height: letters 7 cells, digits 9 — the across-cord axis is width-bound, so it sets pixel
  const cellsAcross = digits ? 9 : 7;
  // Two constraints: ① across-cord within width ratio ② a whole run fits in 75% of visible length
  //   (② matters: width-only math can make a run longer than the cord → you only see fragments)
  const byWidth = (ribbonWidth * CROSS_RATIO * TEX_SCALE) / cellsAcross;
  const byVisible = (visibleCss * 0.75 * TEX_SCALE) / (text.length * (cellsAlong + 1.5));
  const pixel = Math.max(1.2, Math.min(byWidth, byVisible));
  const advance = cellsAlong * pixel + pixel * 1.5;   // 1.5 cells between glyphs
  const runLength = text.length * advance;
  const step = runLength + GAP_CSS * TEX_SCALE;
  const baseV = h / 2 - (cellsAcross * pixel) / 2;    // centered across the cord

  ctx.fillStyle = '#f4f7f1';
  // Print-area right edge: margin at the clip-plate end (else the last run reads as a cut word)
  const printEnd = Math.max(64, w - CLIP_RESERVE_CSS * TEX_SCALE);
  // Lay out **backwards from the clip-plate end** (fixed phase): the visible span always shows
  // the same whole word, and no extra run can butt against the last one to form a long word.
  const runs: number[] = [];
  for (let u = printEnd - runLength; u > 8; u -= step) runs.push(u);
  for (const runStart of runs) {
    for (let i = 0; i < text.length; i++) {
      const u0 = runStart + i * advance;
      if (digits) {
        // Stroke: a slightly larger dark layer first, then the bright glyphs for crisp edges
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#20301f';
        paintSevenSegment(ctx, text[i], u0 - pixel * 0.25, baseV - pixel * 0.25, cellsAlong * pixel + pixel * 0.5, cellsAcross * pixel + pixel * 0.5);
        ctx.restore();
        paintSevenSegment(ctx, text[i], u0, baseV, cellsAlong * pixel, cellsAcross * pixel);
      } else {
        const rows = glyphRows(text[i].toUpperCase());
        const cells: [number, number][] = [];
        for (let row = 0; row < GLYPH_H; row++) {
          for (let col = 0; col < GLYPH_W; col++) {
            if (rows[row][col] === '#') cells.push([col, row]);
          }
        }
        // Outline (8-neighborhood expanded outward by 0.5 px)
        ctx.fillStyle = 'rgba(32,48,31,0.55)';
        for (const [col, row] of cells) {
          ctx.fillRect(u0 + col * pixel - pixel * 0.18, baseV + row * pixel - pixel * 0.18, pixel * 1.36, pixel * 1.36);
        }
        ctx.fillStyle = '#f4f7f1';
        for (const [col, row] of cells) {
          ctx.fillRect(u0 + col * pixel, baseV + row * pixel, pixel, pixel);
        }
      }
    }
  }

  return { pixel, runCss: runLength / TEX_SCALE, gapCss: GAP_CSS };
}

export function createRibbon3D(
  canvas: HTMLCanvasElement,
  options: { width: number },
): Ribbon3D {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  const scene = new Scene();
  // 1 world unit = 1 CSS px; camera looks down from top-left (y down), like page/SVG coords
  const camera = new OrthographicCamera(0, 1, 0, 1, -4000, 4000);
  camera.position.set(0, 0, 2000);
  camera.lookAt(0, 0, 0);


  const frontCanvas = document.createElement('canvas');
  const backCanvas = document.createElement('canvas');
  const frontTexture = new CanvasTexture(frontCanvas);
  const backTexture = new CanvasTexture(backCanvas);
  for (const tex of [frontTexture, backTexture]) {
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    tex.magFilter = NearestFilter; // nearest-neighbor for magnification
    tex.minFilter = NearestFilter; // no mipmap on minify — glyphs/digits would blur into mush
  }

  const geometry = new BufferGeometry();
  const vertexCount = (SEGMENTS + 1) * 2;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    uvs[i * 4 + 0] = i / SEGMENTS;
    uvs[i * 4 + 1] = 0;
    uvs[i * 4 + 2] = i / SEGMENTS;
    uvs[i * 4 + 3] = 1;
  }
  for (let i = 0; i < SEGMENTS; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // winding faces +z, front faces camera
  }
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  // Front / back textures → two meshes (sharing the same geometry)
  // MeshBasicMaterial: the texture color is the final color (no lighting shifting it),
  // volume comes from the baked horizontal shading + self-occlusion (z-buffer, not material)
  const frontMaterial = new MeshBasicMaterial({ map: frontTexture, side: FrontSide });
  const backMaterial = new MeshBasicMaterial({ map: backTexture, side: BackSide });
  const frontMesh = new Mesh(geometry, frontMaterial);
  const backMesh = new Mesh(geometry, backMaterial);
  scene.add(frontMesh, backMesh);

  let viewportW = 1;
  let viewportH = 1;
  let textureLength = 1;
  let textureMetrics = { pixel: 0, runCss: 0, gapCss: 0, arcCss: 0 };
  let labelRef = { front: '', back: '' };
  let visibleRef = 120;

  function setViewport(width: number, height: number, ribbonLength: number, label: { front: string; back: string }, visibleLength: number): void {
    viewportW = Math.max(1, width);
    viewportH = Math.max(1, height);
    textureLength = Math.max(64, ribbonLength);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewportW, viewportH, false);
    canvas.style.width = `${viewportW}px`;
    canvas.style.height = `${viewportH}px`;
    camera.left = 0;
    camera.right = viewportW;
    camera.top = 0;
    camera.bottom = viewportH;
    camera.updateProjectionMatrix();
    labelRef = label;
    visibleRef = visibleLength;
    textureMetrics = { ...paintTexture(frontCanvas, textureLength, label.front, false, options.width, visibleLength), arcCss: 0 };
    paintTexture(backCanvas, textureLength, label.back, true, options.width, visibleLength);
    frontTexture.needsUpdate = true;
    // TODO(temp diagnostic): attach both textures to the DOM for toDataURL export (delete later)
    for (const [id, cv] of [['__tex-front', frontCanvas], ['__tex-back', backCanvas]] as const) {
      let el = document.getElementById(id) as HTMLCanvasElement | null;
      if (!el) {
        el = document.createElement('canvas');
        el.id = id;
        el.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(el);
      }
      el.width = cv.width;
      el.height = cv.height;
      el.getContext('2d')?.drawImage(cv, 0, 0);
    }
    backTexture.needsUpdate = true;
  }

  function update(points: Pt[], twist: number): void {
    if (points.length < 2) return;
    // Arc-length parameterization: uniformly resample SEGMENTS+1 points
    const arc: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      arc.push(arc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    }
    const total = arc[arc.length - 1] || 1;
    // Texture length must match the **mesh arc length** or it squashes/stretches → wrong density
    if (Math.abs(total - textureMetrics.arcCss) > Math.max(8, textureMetrics.arcCss * 0.08)) {
      textureMetrics.arcCss = total;
      textureMetrics = { ...paintTexture(frontCanvas, total, labelRef.front, false, options.width, visibleRef), arcCss: total };
      paintTexture(backCanvas, total, labelRef.back, true, options.width, visibleRef);
      frontTexture.needsUpdate = true;
      backTexture.needsUpdate = true;
    }
    const yTop = 6;
    const clipY = points[points.length - 1].y;
    const ySpan = Math.max(1, clipY - yTop);
    const halfWidth = options.width / 2;
    const twistPeak = twist; // radians, 0..π

    const at = (target: number): { x: number; y: number; tx: number; ty: number } => {
      let i = 1;
      while (i < arc.length - 1 && arc[i] < target) i++;
      const a = points[i - 1];
      const b = points[i];
      const segLength = arc[i] - arc[i - 1] || 1;
      const k = (target - arc[i - 1]) / segLength;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: a.x + dx * k, y: a.y + dy * k, tx: dx / len, ty: dy / len };
    };

    for (let i = 0; i <= SEGMENTS; i++) {
      const s = (total * i) / SEGMENTS;
      const p = at(s);
      // In-plane normal
      const nx = -p.ty;
      const ny = p.tx;
      // Twist profile: 0 at both ends, 180° at the knot (below the knot flips to the back)
      const k = Math.max(0, Math.min(1, (p.y - yTop) / ySpan));
      // Smooth S-curve (not a hard crease): the waist narrows roundly, edges stay curved
      const raw = Math.max(0, Math.min(1, (k - (KNOT_AT - KNOT_WIDTH)) / (2 * KNOT_WIDTH)));
      const step = raw * raw * (3 - 2 * raw);
      const theta = twistPeak * step;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      for (let j = 0; j < 2; j++) {
        const sign = j === 0 ? 1 : -1;
        const idx = (i * 2 + j) * 3;
        positions[idx] = p.x + nx * sign * halfWidth * cos;
        positions[idx + 1] = p.y + ny * sign * halfWidth * cos;
        positions[idx + 2] = sign * halfWidth * sin; // depth: knot strands offset → self-occlusion
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();
    renderer.render(scene, camera);
  }

  return {
    setViewport,
    update,
    info: () => ({ triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, pixel: textureMetrics.pixel, runCss: textureMetrics.runCss, gapCss: textureMetrics.gapCss, textureLength }),
    dispose: () => {
      geometry.dispose();
      frontMaterial.dispose();
      backMaterial.dispose();
      frontTexture.dispose();
      backTexture.dispose();
      renderer.dispose();
    },
  };
}
