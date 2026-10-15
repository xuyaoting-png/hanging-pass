/**
 * "Pixel" labels on the cord: 5×7 bitmap glyphs + placement along the polyline by arc length.
 *
 * Why not <textPath>: every path update re-lays-out the text (hence the old code's throttling),
 * so the path was quantized to 2px / 0.8° and always lagged the strap → "layered, off-track".
 * Per-glyph transforms: same polyline, same frame, transform-only, no re-layout — faster, exact.
 */

export type Pt = { x: number; y: number };

/** 5×7 bitmap glyphs, '#' = one filled square */
const GLYPHS: Record<string, string[]> = {
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'J': ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;

/** 7 bitmap rows for one character; unknown chars return blanks (never throws) */
export function glyphRows(char: string): string[] {
  return GLYPHS[char.toUpperCase()] ?? GLYPHS[' '];
}

export type GlyphPose = { x: number; y: number; angle: number; arc: number; totalArc: number };

type LayoutOptions = {
  /** Base pixel edge length (the side of one "pixel square", px) */
  pixel: number;
  /** Letter spacing (in pixel cells) */
  gapCells?: number;
  /** Only lay out text below this screen y (so it never runs off the top of the viewport) */
  visibleTop?: number;
  /** Arc length (px) reserved at the polyline end for the clip — text must not reach the notch */
  bottomReserve?: number;
};

/**
 * Lay text along the polyline; returns each glyph's center point and tangent angle.
 * Text centers in the "visible span"; if it is short, pixel size shrinks so text always fits.
 */
export function layoutLabel(polyline: Pt[], text: string, options: LayoutOptions): GlyphPose[] {
  if (polyline.length < 2 || !text) return [];
  const { visibleTop = 6 } = options;
  const gapCells = options.gapCells ?? 1;

  // Cumulative arc length
  const arc: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].y - polyline[i - 1].y));
  }
  const totalArc = arc[arc.length - 1] || 1;

  // Visible span: from the first point with y >= visibleTop to the polyline end (the loop)
  let visibleStart = 0;
  for (let i = 0; i < polyline.length; i++) {
    if (polyline[i].y >= visibleTop) { visibleStart = arc[i]; break; }
  }
  const reserve = options.bottomReserve ?? 0;
  const visibleLength = Math.max(0, totalArc - visibleStart - reserve);

  // Adaptive: shrink pixels when the visible span is too short so the text stays complete
  const cellsPerChar = GLYPH_W + gapCells;
  const wanted = text.length * cellsPerChar;
  const pixel = visibleLength > 0 ? Math.min(options.pixel, (visibleLength - 6) / wanted) : options.pixel;
  const advance = cellsPerChar * pixel;
  const textLength = advance * text.length;

  const pointAt = (s: number): { p: Pt; angle: number } => {
    const t = Math.max(0, Math.min(s, totalArc));
    let i = 1;
    while (i < arc.length - 1 && arc[i] < t) i++;
    const a = polyline[i - 1];
    const b = polyline[i];
    const segLength = arc[i] - arc[i - 1] || 1;
    const k = (t - arc[i - 1]) / segLength;
    return {
      p: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k },
      angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI,
    };
  };

  const start = visibleStart + Math.max(0, (visibleLength - textLength) / 2);
  const poses: GlyphPose[] = [];
  for (let i = 0; i < text.length; i++) {
    const arc = start + advance * i + (pixel * GLYPH_W) / 2;
    const { p, angle } = pointAt(arc);
    poses.push({ x: p.x, y: p.y, angle, arc, totalArc });
  }
  return poses;
}
