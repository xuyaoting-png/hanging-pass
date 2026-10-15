/**
 * 吊绳上的「像素体」标签：5×7 位图字模 + 沿折线按弧长摆放。
 *
 * 为什么不用 <textPath>：浏览器每更新一次路径就要重排一次文本（这才是原实现做节流的原因），
 * 于是文字的路径被量化到 2px / 0.8° 才写，摆动时永远落后织带 → 看起来"分层、轨迹不一致"。
 * 改成逐字写 transform：同一份折线、同一帧更新，而且只写 transform、不触发文本重排 —— 更快也更准。
 */

export type Pt = { x: number; y: number };

/** 5×7 位图字模，'#' = 一个实心方块 */
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

/** 取某个字符的 7 行位图；没有字模就返回空白（不会崩） */
export function glyphRows(char: string): string[] {
  return GLYPHS[char.toUpperCase()] ?? GLYPHS[' '];
}

export type GlyphPose = { x: number; y: number; angle: number; arc: number; totalArc: number };

type LayoutOptions = {
  /** 基础像素边长（一个"像素方块"的边长，px） */
  pixel: number;
  /** 字距（以像素格为单位） */
  gapCells?: number;
  /** 只在这个屏幕 y 以下才排字（避免文字跑到视口上方看不见） */
  visibleTop?: number;
  /** 折线末端要给抓夹留出的弧长（px）—— 文字不许顶到抓夹切口上 */
  bottomReserve?: number;
};

/**
 * 把文字沿折线摆放，返回每个字符的中心点与切线角度。
 * 文字在「可见段」内居中；可见段不够长时自动缩小像素边长，保证始终完整落在织带上。
 */
export function layoutLabel(polyline: Pt[], text: string, options: LayoutOptions): GlyphPose[] {
  if (polyline.length < 2 || !text) return [];
  const { visibleTop = 6 } = options;
  const gapCells = options.gapCells ?? 1;

  // 累积弧长
  const arc: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].y - polyline[i - 1].y));
  }
  const totalArc = arc[arc.length - 1] || 1;

  // 可见段：从第一个 y >= visibleTop 的点开始，到折线末端（扣的位置）
  let visibleStart = 0;
  for (let i = 0; i < polyline.length; i++) {
    if (polyline[i].y >= visibleTop) { visibleStart = arc[i]; break; }
  }
  const reserve = options.bottomReserve ?? 0;
  const visibleLength = Math.max(0, totalArc - visibleStart - reserve);

  // 自适应：可见段太短就缩小像素，保证文字完整
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
