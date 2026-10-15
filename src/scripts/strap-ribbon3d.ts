/**
 * 3D 扭转缎带（WebGL / Three.js）
 *
 * 为什么换成真 3D：2D 近似只能"压窄 + 换色"，做不出两件事 ——
 *   ① 表面真的转到侧面（面朝向变化 → 明暗变化）
 *   ② 结处两段互相遮挡（前后关系）
 * 这里把缎带做成真正的 3D 面片：沿绳每点的截面绕切线转 θ(s)，
 * 宽度投影为 w·cosθ、深度为 w·sinθ → 侧过去自然变窄、结处自然互相遮挡；
 * 印花做成贴图铺在面上 → 扭转时文字跟着透视变形、翻面时自动是镜像的。
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

/** 沿绳分段数（越大越圆滑，成本线性） */
const SEGMENTS = 72;
/** 贴图分辨率：**两个轴都用它**（texel / CSS px）。不相等会把字拉伸 */
const TEX_SCALE = 2.2;
/** 贴图高度 = 缎带宽度 × TEX_SCALE（等比，不能写死） */
const texHeight = (ribbonWidth: number): number => Math.max(24, Math.round(ribbonWidth * TEX_SCALE));
/** 结的位置（沿可见段 0..1）与结的角宽 */
const KNOT_AT = 0.42;
const KNOT_WIDTH = 0.26;

export type Ribbon3D = {
  /** 视口/绳长变化时重建贴图与相机 */
  setViewport(width: number, height: number, ribbonLength: number, label: { front: string; back: string }, visibleLength: number): void;
  /** 每帧：按折线与扭转角重建几何并渲染 */
  update(points: Pt[], twist: number): void;
  /** 供验证：渲染统计 */
  info(): { triangles: number; calls: number; pixel: number; runCss: number; gapCss: number; textureLength: number };
  dispose(): void;
};

/**
 * 七段数码管：段位 A 上 / B 右上 / C 右下 / D 下 / E 左下 / F 左上 / G 中。
 * 未点亮的段用 8% 不透明度画出来 —— 这才是 LCD 的质感。
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
 * 把织带展开图（底色 + 织纹 + 缝线 + 满版小字）画进 canvas，用作贴图。
 *
 * 方案 A（满版小字）：
 *   · 尺寸只按**带宽**定 —— 不依赖"可见段长度/弧长比例"这类推算（那套一错就整条没字）
 *   · 字的横跨宽 = 带宽 × 0.28
 *   · 沿绳按"一段印字 + 74 CSS px 间隙"重复铺满
 *   · 字母走位图字模、数字走七段数码管
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

  // 底色 + 横向烘焙明暗（两侧暗、中间亮 → 织物圆润感，不依赖光照）
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#4f5f52');
  base.addColorStop(0.28, '#66796b');
  base.addColorStop(0.5, '#6e8173');
  base.addColorStop(0.72, '#66796b');
  base.addColorStop(1, '#4f5f52');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // 斜纹织纹（压淡，不抢文字）
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

  // 两侧针脚线
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  for (const y of [3.5, h - 3.5]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // ===== 满版小字 =====
  // 坐标系：贴图的 u = 沿绳方向、v = 跨绳方向。
  // 所以"印在带子上看起来转了 90 度"这件事**由贴图坐标系本身完成** ——
  // 不要再用 ctx.rotate：加了反而变成上下镜像（这是前面几轮读不出字的根因之一）。
  const CROSS_RATIO = 0.36;   // 字高（跨绳）/ 带宽
  const GAP_CSS = 40;
  const CLIP_RESERVE_CSS = 58; // 夹片端留白：不要让印字被金属件挡住/截断         // 两段印字之间的间隙
  const cellsAlong = 5;       // 每个字的宽（沿绳）= 5 格（字母与数码管都是）
  // 字高：字母 7 格、数码管 9 格 —— 跨绳方向受带宽约束，所以 pixel 由它决定
  const cellsAcross = digits ? 9 : 7;
  // 两重约束：① 跨绳不超带宽比例 ② 一整段印字必须落进"可见绳长"的 75%
  //    （② 是关键：只按带宽算的话，一段可能比可见绳还长 → 只能看到碎片）
  const byWidth = (ribbonWidth * CROSS_RATIO * TEX_SCALE) / cellsAcross;
  const byVisible = (visibleCss * 0.75 * TEX_SCALE) / (text.length * (cellsAlong + 1.5));
  const pixel = Math.max(1.2, Math.min(byWidth, byVisible));
  const advance = cellsAlong * pixel + pixel * 1.5;   // 字间 1.5 格
  const runLength = text.length * advance;
  const step = runLength + GAP_CSS * TEX_SCALE;
  const baseV = h / 2 - (cellsAcross * pixel) / 2;    // 跨绳居中

  ctx.fillStyle = '#f4f7f1';
  // 印字区右边界：夹片端要留白（否则最后一段被金属件挡住、看着像半截字）
  const printEnd = Math.max(64, w - CLIP_RESERVE_CSS * TEX_SCALE);
  // 从**夹片端往回**排（相位固定）：可见段里永远是同一个位置整词出现，
  // 也不会出现"额外补的一段紧贴末段、两段接成一个长词"的问题。
  const runs: number[] = [];
  for (let u = printEnd - runLength; u > 8; u -= step) runs.push(u);
  for (const runStart of runs) {
    for (let i = 0; i < text.length; i++) {
      const u0 = runStart + i * advance;
      if (digits) {
        // 描边：整体先画一层略大的深色，再画亮字，边界更清楚
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
        // 描边（八邻域向外扩 0.5 像素）
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
  // 1 世界单位 = 1 CSS px；相机从左上角俯视（y 向下），与页面/SVG 坐标一致
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
    tex.magFilter = NearestFilter; // 放大用最近邻
    tex.minFilter = NearestFilter; // 缩小也不用 mipmap —— 否则像素字/数码管一缩小就糊成一团
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
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // 绕序朝 +z，正面才面向镜头
  }
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  // 正面 / 反面两张贴图 → 两个 mesh（同一份几何）
  // MeshBasicMaterial：贴图什么色就什么色（不受光照拉扯），
  // 立体感靠贴图里横向烘焙的明暗 + 几何本身的自遮挡（z-buffer 与材质无关）
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
    // TODO(临时诊断)：把两张贴图挂到 DOM 上，便于用 toDataURL 导出检查（看完即删）
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
    // 弧长参数化，均匀重采样 SEGMENTS+1 个点
    const arc: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      arc.push(arc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
    }
    const total = arc[arc.length - 1] || 1;
    // 贴图长度必须等于**网格折线的弧长**，否则贴图被压缩/拉伸，印花密度对不上
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
    const twistPeak = twist; // 弧度，0..π

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
      // 面内法线
      const nx = -p.ty;
      const ny = p.tx;
      // 扭转剖面：两头 0、结处 180°（结以下整段翻到背面）
      const k = Math.max(0, Math.min(1, (p.y - yTop) / ySpan));
      // 平滑 S 曲线（不是硬折角）：参考图的腰是圆滑的收窄，边缘是曲线
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
        positions[idx + 2] = sign * halfWidth * sin; // 出屏深度：结处两段前后错开 → 自遮挡
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
