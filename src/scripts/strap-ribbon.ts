/**
 * 扭转缎带：把扁平织带画成"被拧过"的形状。
 *
 * 原理（参考图那个叶形/沙漏形）：
 *   θ(s) = Φ × s / L            扭转角沿织带线性分布（挂点 0 → 绳扣 Φ）
 *   w(s) = W/2 × |cos θ(s)|     半宽：正面最宽，侧过去几乎成一条线
 *   明度 ∝ |cos θ|              侧过去只看到窄边 + 阴影，所以更暗
 *
 * 为什么不用描边：SVG 的 stroke 宽度是常量，画不出"中间细两头宽"。
 * 所以按段生成四边形填充，每段一个明度。
 */

export type Pt = { x: number; y: number };

/** 结的位置（沿可见段 0..1）与结的宽度 */
const KNOT_AT = 0.42;
const KNOT_WIDTH = 0.17;

export type RibbonSample = {
  point: Pt;
  /** 单位法线 */
  normal: Pt;
  /** |cos θ|，1 = 正对镜头，0 = 侧过去 */
  facing: number;
  /** 结的收窄系数（1 = 不收窄） */
  pinch: number;
  /** 是否在结的下半（下半显示织带的另一面） */
  flippedSide: boolean;
  /** 沿折线的弧长 */
  arc: number;
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 沿折线采样：返回每个点的法线与 |cos θ| */
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
    // 法线 = 切线逆时针 90°
    const normal = { x: -dy / length, y: dx / length };
    // 扭转剖面：**局部掐一个点**（打结），不是整条螺旋。
    //   k       = 沿可见段的位置 0..1
    //   pinch   = 1 - 深度 × 高斯钟形(k)  → 只在结的位置收窄，其余全宽
    // 参考图就是：上面全宽 → 一个交叉点 → 下面全宽 → 全宽插进金属件。
    const ySpan = Math.max(1, yBottom - yTop);
    const twistK = Math.max(0, Math.min(1, (point.y - yTop) / ySpan));
    const depth = Math.abs(twist) / ((180 * Math.PI) / 180);   // 翻面进度 0..1（背面 = 1）
    const knot = Math.exp(-Math.pow((twistK - KNOT_AT) / KNOT_WIDTH, 2));
    const pinch = 1 - Math.max(0, Math.min(1, depth)) * knot;
    const theta = twist * knot;
    out.push({ point, normal, facing: Math.abs(Math.cos(theta)), pinch, flippedSide: twistK > KNOT_AT, arc: target });
  }
  return out;
}

/** 缎带轮廓（左缘下去、右缘回来）：用于一次性填充 */
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

/** 每一段的四边形 + 明度（0=最暗，1=最亮），用于逐段填充做扭转的明暗 */
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
    // 用"离结的远近"把正面色平滑插值到反面色：这是翻面，不是加一层阴影
    const mix = clamp01(((a.flippedSide ? 1 : 0) + (bS.flippedSide ? 1 : 0)) / 2);
    // 侧过去时整体压暗一点（只做色调，不叠半透明层 → 不会出现多余阴影）
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

/** 折线中心线的 d（高光/刃线用） */
export function centerlinePath(samples: RibbonSample[]): string {
  if (samples.length < 2) return '';
  return `M ${samples.map((s) => `${s.point.x.toFixed(2)} ${s.point.y.toFixed(2)}`).join(' L ')}`;
}

/**
 * 扭转量：跟"翻面进度"线性走 —— 0°(正面) → 0、90° → 一半、180°(背面) → 满扭并**保持**。
 * 用户要的行为：点一下翻到背面，麻花扭起来并且**停在那个状态**；再点一下才还原。
 * （之前用 sin 包络是"中途最大、两面归零"，所以翻到背面反而松开了 —— 错。）
 */
export function twistEnvelope(flipAngleDeg: number, maxDeg = 150): number {
  const k = Math.max(0, Math.min(1, Math.abs(flipAngleDeg) / 180));
  return (k * maxDeg * Math.PI) / 180;
}


/** 窄版缎带（高光/内层用）：和主缎带同一剖面，只是半宽更小 */
export function ribbonBandPath(samples: RibbonSample[], halfWidth: number): string {
  return ribbonOutline(samples, halfWidth);
}
