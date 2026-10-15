/**
 * Twisted ribbon: draw the flat webbing as a shape that has been "wrung".
 *
 * Principle (the leaf/hourglass shape in the reference image):
 *   θ(s) = Φ × s / L            twist angle linear along strap (hang point 0 → cord loop Φ)
 *   w(s) = W/2 × |cos θ(s)|     half-width: widest face-on, nearly a line edge-on
 *   brightness ∝ |cos θ|        edge-on you only see the narrow edge + shadow, hence darker
 *
 * Why not a stroke: SVG stroke width is constant, it cannot draw "thin middle, wide ends".
 * So we emit one quad per segment, one brightness value each.
 */

export type Pt = { x: number; y: number };

/** Knot position (along the visible span 0..1) and the knot width */
const KNOT_AT = 0.42;
const KNOT_WIDTH = 0.17;

export type RibbonSample = {
  point: Pt;
  /** Unit normal */
  normal: Pt;
  /** |cos θ|, 1 = facing the camera, 0 = edge-on */
  facing: number;
  /** Knot pinch factor (1 = no pinching) */
  pinch: number;
  /** Whether this is in the lower half of the knot (shows the strap's other face) */
  flippedSide: boolean;
  /** Arc length along the polyline */
  arc: number;
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Sample along the polyline: returns each point's normal and |cos θ| */
export function sampleRibbon(polyline: Pt[], twist: number, steps = 24, yTop = 0, yBottom = 0): RibbonSample[] {
  if (polyline.length < 2) return [];
  const arc: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].y - polyline[i - 1].y));
  }
  const total = arc[arc.length - 1] || 1;
  const out: RibbonSample[] = [];
  const count = Math.max(2, steps);
  for (let s = 0; s <= count; s++) {
    const target = (total * s) / count;
    let i = 1;
    while (i < arc.length - 1 && arc[i] < target) i++;
    const a = polyline[i - 1];
    const b = polyline[i];
    const segLength = arc[i] - arc[i - 1] || 1;
    const k = (target - arc[i - 1]) / segLength;
    const point = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    // Normal = tangent rotated 90° counter-clockwise
    const normal = { x: -dy / length, y: dx / length };
    // Twist profile: **pinch a single point locally** (the knot), not a full-length helix.
    //   k       = position along the visible span 0..1
    //   pinch   = 1 - depth × gaussian(k)  → narrows only at the knot, full width elsewhere
    // The reference image: full width top → one crossing → full width bottom → into the metal.
    const ySpan = Math.max(1, yBottom - yTop);
    const twistK = Math.max(0, Math.min(1, (point.y - yTop) / ySpan));
    const depth = Math.abs(twist) / ((180 * Math.PI) / 180);   // flip progress 0..1 (back = 1)
    const knot = Math.exp(-Math.pow((twistK - KNOT_AT) / KNOT_WIDTH, 2));
    const pinch = 1 - Math.max(0, Math.min(1, depth)) * knot;
    const theta = twist * knot;
    out.push({ point, normal, facing: Math.abs(Math.cos(theta)), pinch, flippedSide: twistK > KNOT_AT, arc: target });
  }
  return out;
}

/** Ribbon outline (down the left edge, back up the right): for a one-shot fill */
export function ribbonOutline(samples: RibbonSample[], halfWidth: number): string {
  if (samples.length < 2) return '';
  const left: string[] = [];
  const right: string[] = [];
  for (const s of samples) {
    const w = halfWidth * s.facing * s.pinch;
    left.push(`${(s.point.x + s.normal.x * w).toFixed(2)} ${(s.point.y + s.normal.y * w).toFixed(2)}`);
    right.push(`${(s.point.x - s.normal.x * w).toFixed(2)} ${(s.point.y - s.normal.y * w).toFixed(2)}`);
  }
  right.reverse();
  return `M ${left.join(' L ')} L ${right.join(' L ')} Z`;
}

/** Quad + brightness per segment (0 = darkest, 1 = brightest), per-segment twist shading */
export function ribbonQuads(
  samples: RibbonSample[],
  halfWidth: number,
  frontColor = '#627564',
  backColor = '#4c5d50',
): { d: string; fill: string; flippedSide: boolean }[] {
  const hex = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const f = hex(frontColor);
  const b = hex(backColor);
  const out: { d: string; fill: string; flippedSide: boolean }[] = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const bS = samples[i + 1];
    const wa = halfWidth * a.facing * a.pinch;
    const wb = halfWidth * bS.facing * bS.pinch;
    const p1 = { x: a.point.x + a.normal.x * wa, y: a.point.y + a.normal.y * wa };
    const p2 = { x: bS.point.x + bS.normal.x * wb, y: bS.point.y + bS.normal.y * wb };
    const p3 = { x: bS.point.x - bS.normal.x * wb, y: bS.point.y - bS.normal.y * wb };
    const p4 = { x: a.point.x - a.normal.x * wa, y: a.point.y - a.normal.y * wa };
    // Lerp front color to back color by proximity to the knot: flipping, not a shadow layer
    const mix = clamp01(((a.flippedSide ? 1 : 0) + (bS.flippedSide ? 1 : 0)) / 2);
    // Edge-on looks slightly darker overall (tone only, no translucent layer → no extra shadows)
    const edge = 1 - (1 - clamp01((a.facing + bS.facing) / 2)) * 0.18;
    const rgb = f.map((v, k2) => Math.round((v + (b[k2] - v) * mix) * edge));
    out.push({
      d: `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} L ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)} L ${p4.x.toFixed(2)} ${p4.y.toFixed(2)} Z`,
      fill: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
      flippedSide: a.flippedSide,
    });
  }
  return out;
}

/** Polyline centerline path `d` (used for the highlight/blade line) */
export function centerlinePath(samples: RibbonSample[]): string {
  if (samples.length < 2) return '';
  return `M ${samples.map((s) => `${s.point.x.toFixed(2)} ${s.point.y.toFixed(2)}`).join(' L ')}`;
}

/**
 * Twist amount: linear in "flip progress" — 0° (front) → 0, 90° → half, 180° (back) → full.
 * Wanted: tap once to flip to the back; the twist winds up and **stops in that state**; tap
 * again to restore. (Old sin envelope peaked mid-flip, zeroed on both faces — wrong.)
 */
export function twistEnvelope(flipAngleDeg: number, maxDeg = 150): number {
  const k = Math.max(0, Math.min(1, Math.abs(flipAngleDeg) / 180));
  return (k * maxDeg * Math.PI) / 180;
}


/** Narrow ribbon (highlight/inner layer): same profile as the main ribbon, smaller half-width */
export function ribbonBandPath(samples: RibbonSample[], halfWidth: number): string {
  return ribbonOutline(samples, halfWidth);
}
