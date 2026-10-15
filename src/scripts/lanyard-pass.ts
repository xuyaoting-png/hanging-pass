import { GLYPH_H, GLYPH_W, glyphRows, layoutLabel } from './strap-glyphs';
import { centerlinePath, ribbonBandPath, ribbonOutline, ribbonQuads, sampleRibbon, twistEnvelope } from './strap-ribbon';
import { createRibbon3D, type Ribbon3D } from './strap-ribbon3d';
import { createSim } from './lanyard-physics';
import type { LanyardMorphController } from './lanyard-morph';

type Face = 'front' | 'back';
type Sim = ReturnType<typeof createSim>;
type Point2D = { x: number; y: number };

const TARGET_PERIOD = 1.86;
const BASE_ROPE_RATIO = 0.62;
// 织带末端要伸进抓夹内部（原来是停在绳扣前 42px，切口露在抓夹外面，看着像没连上）
const STRAP_TAIL = 22;
const MAX_SWING = 88 * Math.PI / 180;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function initLanyardPass(morph: LanyardMorphController): void {
  const scene = document.querySelector<HTMLElement>('.badge-scene');
  const badge = scene?.querySelector<HTMLElement>('.badge-card');
  const hole = badge?.querySelector<HTMLElement>('.badge-hole');
  const tilt = badge?.querySelector<HTMLElement>('.badge-tilt');
  const flip = badge?.querySelector<HTMLElement>('.badge-flip');
  const front = badge?.querySelector<HTMLElement>('.badge-face--front');
  const back = badge?.querySelector<HTMLElement>('.badge-face--back');
  const strapBand = scene?.querySelector<SVGPathElement>('[data-strap-band]');
  const strapWeave = scene?.querySelector<SVGPathElement>('[data-strap-weave]');
  const strapHighlight = scene?.querySelector<SVGPathElement>('[data-strap-highlight]');
  const strapThread = scene?.querySelector<SVGPathElement>('[data-strap-thread]');
  const strapLabel = scene?.querySelector<SVGGElement>('[data-strap-label]');
  const strapShade = scene?.querySelector<SVGGElement>('[data-strap-shade]');
  const ribbonCanvas = scene?.querySelector<HTMLCanvasElement>('[data-strap-ribbon3d]');
  const strapRig = scene?.querySelector<SVGSVGElement>('[data-rig-strap]');
  const clip = scene?.querySelector<SVGGElement>('[data-rig-clip]');
  const ring = scene?.querySelector<SVGGElement>('[data-rig-ring]');
  if (!scene || !badge || !hole || !tilt || !flip || !front || !back ||
      !strapBand || !strapHighlight || !strapThread || !strapLabel || !clip || !ring) return;

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionPreference.matches;
  let sim: Sim;
  let cardW = 0;
  let cardH = 0;
  let holeOffset = 0;
  let sceneRect = scene.getBoundingClientRect();
  let pin: Point2D = { x: 0, y: 0 };
  let baseRopeLength = 0;
  // 弹性挂绳：拖拽时可以把挂绳拉长（上限 CORD_STRETCH），松手后由欠阻尼弹簧拉回静止长度，
  // 于是出现「往下拉 → 弹起来」的回弹（ζ≈0.35，会来回几下再停）。
  const CORD_STRETCH = 0.28;
  const ROPE_SPRING = 150;
  const ROPE_DAMPING = 12;    // 8.5 → 12：落下弹回更快收住
  let ropeLength = 0;
  let ropeVelocity = 0;
  // 入场（保守档）：挂绳预拉伸一点让它自己落下弹回，再给一个横向冲量左右晃，
  // 约 4s 衰减到静止。数值可以直接调这三个。
  // dx/dy = 推开的距离（会自然晃回来）；ropeStretch = 挂绳预拉伸（落下弹回）
  // angle = 起摆角度(rad)，约 0.03 rad ≈ 20px（总摆长 665px）；ropeStretch = 挂绳预拉伸
  // 模拟"人上手抓一下再松手"：先被拽下去（挂绳拉长）→ 弹回 → 甩一下左右摆几回。
  // 注意（踩过的坑）：冲量给太猛会超出 PBD 求解器的单步修正能力 —— 绳长被拉长，
  // 卡片会看着和带子"脱开"。所以这里取"肉眼明显但不暴力"的量级：
  //   ropeStretch 0.08 ≈ 纵向 30px；angle 0.025 + omega 0.1 ≈ 横向 60–70px
  const ENTRANCE = { ropeStretch: 0.075, angle: 0.035, omega: 0.14 };  // 整体收 25%：入场更含蓄
  // 入场后 1.2s 内的 layout 抖动会触发 measure() 重建 sim，重建会把冲量冲掉 ——
  // 所以在这个窗口内的重建要补发一次，之后不再重播。
  let entranceScale = 0;
  let entranceRetryUntil = 0;
  let cordLength = 0;
  let maxVisibleAngle = MAX_SWING;
  let minVisibleY = 0;
  let face: Face = 'front';
  let flipAngle = 0;
  let flipVelocity = 0;
  let flipTarget = 0;
  let tiltX = 0;
  let tiltY = 0;
  let lastTime = 0;
  let raf = 0;
  let resizeRaf = 0;
  let wakeTime = 0;
  let stableFrames = 0;
  let lastAngle = 0;
  let dragTarget: Point2D | null = null;
  let measuredViewport = { w: 0, h: 0 };
  const pointer = { id: -1, x: 0, y: 0, started: 0, moved: 0, lastMove: 0, grabX: 0, grabY: 0 };

  // Keep the original markup visible until all geometry and the first SVG frame are ready.
  // 像素体标签：按字模生成每字一个 <g>（只建一次），每帧只写 transform
  // 扭转缎带的暗部：24 段四边形（只建一次，每帧只改 d 与透明度）
  const RIBBON_STEPS = 24;
  const shadeQuads: SVGPathElement[] = [];
  for (let i = 0; i < RIBBON_STEPS; i++) {
    const quad = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    quad.setAttribute('fill', '#26382b');
    quad.setAttribute('opacity', '0');
    strapShade?.appendChild(quad);
    shadeQuads.push(quad);
  }

  // 3D 缎带（Three.js）接管织带与印花；SVG 那套带子/高光/缝线/像素字隐藏
  let ribbon3d: Ribbon3D | null = null;
  if (ribbonCanvas) {
    ribbon3d = createRibbon3D(ribbonCanvas, { width: 34 });
    for (const el of [strapBand, strapWeave, strapHighlight, strapThread, strapLabel, strapShade]) {
      if (el) (el as unknown as HTMLElement).style.display = 'none';
    }
  }

  const LABEL_TEXT = 'HELLO';
  const LABEL_PIXEL = 1.5;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const labelGlyphs: SVGGElement[] = [];
  for (const char of LABEL_TEXT) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'badge-rig__glyph');
    const rows = glyphRows(char);
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row].length; col++) {
        if (rows[row][col] !== '#') continue;
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(col));
        rect.setAttribute('y', String(row));
        rect.setAttribute('width', '1');
        rect.setAttribute('height', '1');
        group.appendChild(rect);
      }
    }
    strapLabel.appendChild(group);
    labelGlyphs.push(group);
  }

  function measure(): void {
    measuredViewport = { w: window.innerWidth, h: window.innerHeight };
    badge.style.transform = 'none';
    sceneRect = scene.getBoundingClientRect();
    const cardRect = badge.getBoundingClientRect();
    const holeRect = hole.getBoundingClientRect();
    cardW = cardRect.width;
    cardH = cardRect.height;
    holeOffset = holeRect.top + holeRect.height / 2 - cardRect.top;
    badge.style.setProperty('--badge-hole-offset', `${holeOffset}px`);

    cordLength = cardH / 2 - holeOffset;
    baseRopeLength = Math.max(220, sceneRect.height * BASE_ROPE_RATIO);
    const restComY = sceneRect.height / 2;
    const restClipY = restComY - cordLength;
    pin = { x: sceneRect.width / 2, y: restClipY - baseRopeLength };
    const totalReach = baseRopeLength + cordLength;
    // Keep part of the badge visible even when a pointer is dragged past the viewport.
    minVisibleY = cardH * 0.25;
    const horizontalReach = Math.max(0, sceneRect.width / 2 - cardW * 0.25);
    const verticalReach = Math.max(0, minVisibleY - pin.y);
    maxVisibleAngle = Math.min(
      MAX_SWING,
      Math.asin(clamp(horizontalReach / totalReach, 0, 1)),
      Math.acos(clamp(verticalReach / totalReach, -1, 1)),
    );
    // The light strap keeps the clip nearly fixed. The final clip-to-card
    // constraint shortens the solver's effective pendulum radius further;
    // 0.7 matches the requested 1.86s swing in the rendered page.
    const effectivePendulumLength = cordLength * 0.7;
    sim = createSim({
      ropeLength: baseRopeLength,
      cordLength,
      pinX: pin.x,
      pinY: pin.y,
      gravity: 4 * Math.PI * Math.PI * effectivePendulumLength / (TARGET_PERIOD * TARGET_PERIOD),
      // 子步翻倍：长链需要更多子步，否则大冲量下约束修不过来（绳长被拉长/卡片甩出）
      fixedDt: 1 / 120,
      frictionPerFrame: 0.9915,   // 0.99 → 0.988：甩动衰减更快、收得住
      chainInvMass: 0.06,
      bendStiffness: 0.45,        // 0.3 → 0.45：织带更挺，拖动时不糊成一团
      maxAngle: maxVisibleAngle,
      returnStrength: 12,
    });
    lastAngle = 0;
    dragTarget = null;
    // 可见绳长：折线里 y ≥ 0 的那一段（挂点那截在屏幕外）
    let visibleRope = 0;
    const pts = sim.state().points;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y < 0 || pts[i - 1].y < 0) continue;
      visibleRope += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    // 贴图长度必须用**折线真实弧长**（UV 覆盖的就是它），不能用 baseRopeLength + cordLength
    let ropeArc = 0;
    for (let i = 1; i < pts.length; i++) ropeArc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    ribbon3d?.setViewport(sceneRect.width, sceneRect.height, Math.max(120, ropeArc), { front: 'HELLO', back: '2025' }, Math.max(60, visibleRope));
    ropeLength = baseRopeLength;
    ropeVelocity = 0;
    if (performance.now() < entranceRetryUntil) fireEntrance(entranceScale);
    render();
  }

  function toLocal(event: PointerEvent): Point2D {
    return { x: event.clientX - sceneRect.left, y: event.clientY - sceneRect.top };
  }

  function clampToReach(point: Point2D): Point2D {
    const dx = point.x - pin.x;
    const dy = point.y - pin.y;
    // 上限要包含挂绳的拉伸量，否则指针够不到往下拉的那一段
    const length = baseRopeLength * (1 + CORD_STRETCH) + cordLength;
    const radius = clamp(Math.hypot(dx, dy), Math.max(length * 0.6, minVisibleY - pin.y), length);
    const angle = clamp(Math.atan2(dx, dy), -maxVisibleAngle, maxVisibleAngle);
    return { x: pin.x + Math.sin(angle) * radius, y: pin.y + Math.cos(angle) * radius };
  }

  function render(): void {
    const state = sim.state();
    const points = state.points;
    const lastLink = points[points.length - 3];
    const clipPoint = state.clip;
    let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    let lastDrawn = points[0];
    for (let i = 1; i < points.length - 2; i++) {
      if (Math.hypot(points[i].x - clipPoint.x, points[i].y - clipPoint.y) <= STRAP_TAIL) break;
      path += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
      lastDrawn = points[i];
    }
    const endX = clipPoint.x - lastDrawn.x;
    const endY = clipPoint.y - lastDrawn.y;
    const endLength = Math.hypot(endX, endY) || 1;
    path += ` L ${(clipPoint.x - endX / endLength * STRAP_TAIL).toFixed(2)} ${(clipPoint.y - endY / endLength * STRAP_TAIL).toFixed(2)}`;
    // 先把刚写下的同一条 d 解析成折线（缎带、像素字、夹片旋转都读这一份，保证同源）
    const polyline: { x: number; y: number }[] = [];
    for (const match of path.matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
      polyline.push({ x: Number(match[2]), y: Number(match[3]) });
    }

    // 扭转缎带：Φ = sin(翻面角) × 90° —— 翻面中途扭到最大、两面归零
    // （用户要的就是"点一下翻到背面 + 整条挂绳扭一下，再点还原"）
    // 半圈（150°）= 参考图那种"上宽 → 中间细 → 下宽"的麻花。
    // 扭转按屏幕 y 分布：可见段顶部 0° → 底部 150°（中途经过 75° 时最细）
    const twist = twistEnvelope(flipAngle, 150);
    const clipY = polyline.length ? polyline[polyline.length - 1].y : 0;
    // 3D 缎带：真半圈（结以下整段翻到背面，自遮挡由 z 深度产生）
    ribbon3d?.update(polyline, twistEnvelope(flipAngle, 180));
    const ribbon = sampleRibbon(polyline, twist, RIBBON_STEPS, 6, clipY);
    const halfWidth = 17;
    strapBand.setAttribute('d', ribbonOutline(ribbon, halfWidth));
    const quads = ribbonQuads(ribbon, halfWidth);
    const avgFacing = ribbon.reduce((sum, r) => sum + r.facing, 0) / Math.max(1, ribbon.length);
    for (let i = 0; i < shadeQuads.length; i++) {
      const quad = quads[i];
      // 直接用不透明插值色铺满整条缎带：不再叠半透明层，所以不会多出"结处的阴影"
      shadeQuads[i].setAttribute('d', quad ? quad.d : '');
      shadeQuads[i].setAttribute('fill', quad ? quad.fill : 'none');
      shadeQuads[i].setAttribute('opacity', quad ? '1' : '0');
    }
    const line = centerlinePath(ribbon);
    // 高光也必须是"随扭转变窄的缎带"：定宽描边在侧过去时会变成一条浮着的独立条
    strapHighlight.setAttribute('d', ribbonBandPath(ribbon, halfWidth * 0.58));
    strapHighlight.setAttribute('fill', '#718570');
    strapHighlight.setAttribute('stroke', 'none');
    strapHighlight.setAttribute('opacity', '1');
    strapThread.setAttribute('d', line);
    strapThread.setAttribute('opacity', ((1 - avgFacing) * 0.85).toFixed(3));
    strapWeave?.setAttribute('d', path);
    strapWeave?.setAttribute('opacity', '0');
    // 标签：解析刚写下的同一条 d（保证和织带完全同源、同一帧），逐字按弧长摆位
    const poses = layoutLabel(polyline, LABEL_TEXT, { pixel: LABEL_PIXEL, visibleTop: 6, bottomReserve: 34 });
    for (let i = 0; i < labelGlyphs.length && i < poses.length; i++) {
      const pose = poses[i];
      // 侧过去时把字压窄 —— 必须和缎带用同一个基准（屏幕 y），否则字和带子各扭各的
      const glyphK = Math.max(0, Math.min(1, (pose.y - 6) / Math.max(1, clipY - 6)));
      // 织带侧过去时压的是「带宽度方向」= 字的 y 轴（不是字的 x 轴）
      const knot = Math.exp(-Math.pow((glyphK - 0.42) / 0.17, 2));
      const facing = 1 - Math.max(0, Math.min(1, Math.abs(twist) / Math.PI)) * knot;
      // 结以下看到的是印花的「背面」→ 沿织带宽度方向镜像（这就是"翻到背面"的读法）
      const mirrored = glyphK > 0.42 && Math.abs(twist) > 0.25;
      labelGlyphs[i].setAttribute(
        'transform',
        `translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) rotate(${pose.angle.toFixed(2)}) scale(${LABEL_PIXEL} ${(LABEL_PIXEL * Math.max(0.08, facing) * (mirrored ? -1 : 1)).toFixed(3)}) translate(${-GLYPH_W / 2} ${-GLYPH_H / 2})`,
      );
    }

    // CSS/SVG rotate() must receive the negative of the physical angle.
    const rotation = -state.angleDeg;
    // 夹片是刚体、织带是曲线：用"末端切线"会让夹片和织带口的方向差几度，
    // 37px 的杠杆下就能把 34px 宽的织带从 46px 宽的夹片侧面顶出来。
    // 所以取「夹片口高度处」的织带方向（沿折线往回退 PLATE_HEIGHT 的距离）。
    const PLATE_HEIGHT = 34;
    let mouthPoint = lastDrawn;
    let walked = 0;
    for (let i = polyline.length - 1; i > 0; i--) {
      const a = polyline[i];
      const b = polyline[i - 1];
      const seg = Math.hypot(a.x - b.x, a.y - b.y);
      if (walked + seg >= PLATE_HEIGHT) {
        const k = (PLATE_HEIGHT - walked) / (seg || 1);
        mouthPoint = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
        break;
      }
      walked += seg;
      mouthPoint = b;
    }
    const tailAngle = Math.atan2(clipPoint.y - mouthPoint.y, clipPoint.x - mouthPoint.x) * 180 / Math.PI;
    // 翻面时吊绳"跟着翻转"：以绳扣为轴，整条织带扭一下，翻转中途最大、两面归零。
    // 用 sin 包络（0°→0、90°→峰值、180°→0），所以不会在两面留下歪掉的织带。
    // 上面 twist 是"真·缎带扭转"（弧度）。这里再给整条 rig 一点点倾角（五金跟着歪一点），
    // 幅度取扭转的 1/4 —— 主要效果由缎带承担，rig 只做辅助。
    // 绳子必须保持在垂直线上"原地扭"：整条 rig 不做刚体旋转（那会变成横向甩动）
    const rigTwist = 0;
    if (strapRig) {
      strapRig.style.transformOrigin = `${clipPoint.x.toFixed(2)}px ${clipPoint.y.toFixed(2)}px`;
      strapRig.style.setProperty('--strap-twist', `${rigTwist.toFixed(3)}deg`);
    }
    // 金属件跟着卡片翻：用水平压扁模拟 rotateY（绕绳扣为原点，所以从本地原点缩放）
    const flipScale = Math.max(0.12, Math.abs(Math.cos((flipAngle * Math.PI) / 180)));
    clip.setAttribute('transform', `translate(${clipPoint.x.toFixed(3)} ${clipPoint.y.toFixed(3)}) rotate(${(tailAngle - 90 + rigTwist).toFixed(4)}) scale(${flipScale.toFixed(3)} 1)`);
    ring.setAttribute('transform', `translate(${clipPoint.x.toFixed(3)} ${clipPoint.y.toFixed(3)}) rotate(${(rotation + rigTwist * 0.6).toFixed(4)}) scale(${flipScale.toFixed(3)} 1)`);
    // 卡片位姿：形变期间统一由 lanyard-morph 写（两个循环同时写会互相覆盖），
    // progress≈0 时仍由物理写，保证静止/拖拽由物理驱动。
    if (morph.getProgress() <= 0.001) {
      badge.style.transform = `translate3d(${(state.com.x - cardW / 2).toFixed(4)}px, ${(state.com.y - cardH / 2).toFixed(4)}px, 0) rotate(${rotation.toFixed(4)}deg)`;
      tilt.style.transform = `rotateX(${tiltX.toFixed(3)}deg) rotateY(${tiltY.toFixed(3)}deg)`;
    }
    flip.style.transform = `rotateY(${flipAngle.toFixed(3)}deg)`;
    morph.update({
      width: sceneRect.width,
      height: sceneRect.height,
      centerX: state.com.x,
      centerY: state.com.y,
      angle: state.angleDeg,
      velocityX: state.velocity.x,
      velocityY: state.velocity.y,
    });

    // Read-only inspection hook; it does not feed back into the simulation.
    debugState = Object.freeze({
      com: Object.freeze({ x: state.com.x + sceneRect.left, y: state.com.y + sceneRect.top }),
      clip: Object.freeze({ x: clipPoint.x + sceneRect.left, y: clipPoint.y + sceneRect.top }),
      holeOffset,
      cardW,
      cardH,
      angle: state.angleDeg,
      ...morph.getDebugState(),
    });
  }

  function frame(time: number): void {
    raf = 0;
    if (document.hidden) return;
    const dt = clamp(lastTime ? (time - lastTime) / 1000 : 1 / 60, 1 / 240, 1 / 30);
    lastTime = time;
    if (!reduced) {
      if (dragTarget) {
        const reach = Math.hypot(dragTarget.x - pin.x, dragTarget.y - pin.y);
        ropeLength = clamp(reach - cordLength, baseRopeLength * 0.35, baseRopeLength * (1 + CORD_STRETCH));
        ropeVelocity = 0;
      } else {
        // 松手后：阻尼弹簧把挂绳拉回静止长度 —— 这一步产生「弹起来」的回弹
        const acc = (baseRopeLength - ropeLength) * ROPE_SPRING - ropeVelocity * ROPE_DAMPING;
        ropeVelocity += acc * dt;
        ropeLength += ropeVelocity * dt;
      }
      sim.setRopeLength(ropeLength);
      if (morph.getProgress() <= 0.04) sim.step(dt);
      const state = sim.state();
      // 三维倾斜上限压小：原来 ±30°/±42° 时，大幅摆动会让卡片像"甩飞/脱开"，
      // 现在 ±9°/±12° —— 仍然是"卡片在晃"，但不会看着断开。
      const targetX = clamp(state.velocity.y * 0.008, -9, 9);
      const targetY = clamp(-state.velocity.x * 0.012, -12, 12);
      const factor = 1 - Math.exp(-dt * 7);
      tiltX += (targetX - tiltX) * factor;
      tiltY += (targetY - tiltY) * factor;
      const acceleration = (flipTarget - flipAngle) * 190 - flipVelocity * 24;
      flipVelocity += acceleration * dt;
      flipAngle += flipVelocity * dt;
      if (Math.abs(flipTarget - flipAngle) < 0.05 && Math.abs(flipVelocity) < 0.05) {
        flipAngle = flipTarget;
        flipVelocity = 0;
      }
    } else {
      flipAngle = flipTarget;
      flipVelocity = 0;
      tiltX = 0;
      tiltY = 0;
    }
    render();

    const angle = sim.state().angleDeg;
    const settled = pointer.id === -1 && Math.abs(angle) < 0.15 &&
      Math.abs(angle - lastAngle) < 0.015 && Math.abs(flipTarget - flipAngle) < 0.05 &&
      Math.abs(tiltX) < 0.15 && Math.abs(tiltY) < 0.15;
    stableFrames = settled ? stableFrames + 1 : 0;
    lastAngle = angle;
    if (pointer.id !== -1 || (stableFrames < 30 && time - wakeTime < 7000)) raf = requestAnimationFrame(frame);
    else lastTime = 0;
  }

  function wake(): void {
    wakeTime = performance.now();
    stableFrames = 0;
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }

  morph.setPhysicsResumeHandler(wake);

  function setFace(nextFace: Face): void {
    face = nextFace;
    flipTarget = face === 'front' ? 0 : 180;
    front.setAttribute('aria-hidden', String(face !== 'front'));
    back.setAttribute('aria-hidden', String(face !== 'back'));
    badge.setAttribute('aria-label', `Demo profile card, ${face} side. Press Enter or Space to flip.`);
    if (reduced) { flipAngle = flipTarget; render(); }
    else wake();
  }

  /**
   * 入场冲量。scale 用来给"回到吊牌"一个更小的版本。
   * 只在第一屏、非减少动态效果、且用户没在拖拽时生效。
   */
  function fireEntrance(scale: number): void {
    const narrow = window.innerWidth <= 760;
    // 织带长度 = 0.62 × 视口高：738 高时 457px，1490 高时 882px。
    // 链子段数不变、每段翻倍 → 长链等效更软，同样的冲量会把绳拉长、卡片甩出。
    // 所以冲量按绳长反比缩放，保证不同窗口下视觉幅度一致、且不出求解器稳定区。
    const ropeScale = Math.min(1, Math.max(0.62, 457 / Math.max(1, baseRopeLength)));
    const k = scale * (narrow ? 0.7 : 1) * ropeScale;
    ropeLength = baseRopeLength * (1 + ENTRANCE.ropeStretch * k);
    ropeVelocity = 0;
    sim.setRopeLength(ropeLength);
    // 从静止放开到一侧：重力力矩驱动摆动，阻尼约 4s 停
    sim.swing(ENTRANCE.angle * k, ENTRANCE.omega);
    wake();
  }

  function playEntrance(scale: number): void {
    if (reduced || sim.state().dragging) return;
    entranceScale = scale;
    entranceRetryUntil = performance.now() + 1200;
    fireEntrance(scale);
  }

  function endPointer(event: PointerEvent, canceled: boolean): void {
    if (pointer.id !== event.pointerId) return;
    // A very quick swipe may finish before the next animation frame. Commit
    // its final target once so the card still follows the gesture.
    if (!reduced && dragTarget && pointer.moved >= 6) {
      const reach = Math.hypot(dragTarget.x - pin.x, dragTarget.y - pin.y);
      ropeLength = clamp(reach - cordLength, baseRopeLength * 0.35, baseRopeLength * (1 + CORD_STRETCH));
      ropeVelocity = 0;
      sim.setRopeLength(ropeLength);
      sim.step(1 / 60);
      render();
    }
    if (!reduced) {
      // 不再瞬间把挂绳设回静止长度：交给阻尼弹簧回弹（这就是「拉下去弹起来」）
      sim.release();
    }
    badge.classList.remove('is-dragging');
    if (badge.hasPointerCapture(event.pointerId)) badge.releasePointerCapture(event.pointerId);
    const click = !canceled && pointer.moved < 6 && performance.now() - pointer.started < 400;
    // 浏览器在拖拽后照样会派发 click —— 这里打个标记，交给 morph 决定"不翻面"。
    // 短按（<6px 且 <400ms）= 翻面；长按/拖拽后松手 = 不翻面。
    if (!click) badge.dataset.wasDrag = '1';
    pointer.id = -1;
    dragTarget = null;
    // 翻面统一由 lanyard-morph 的 flipIndex 决定（这里再翻一次会互相抵消）
    if (!click && !reduced) wake();
  }

  let debugState: Readonly<{
    com: Readonly<Point2D>;
    clip: Readonly<Point2D>;
    holeOffset: number;
    cardW: number;
    cardH: number;
    angle: number;
  }>;
  Object.defineProperty(window, '__lanyard', {
    configurable: true,
    get: () => Object.freeze({ ...debugState, ...morph.getDebugState() }),
  });

  measure();

  back.hidden = false;
  back.setAttribute('aria-hidden', 'true');
  badge.setAttribute('role', 'button');
  badge.setAttribute('tabindex', '0');
  badge.setAttribute('aria-label', 'Demo profile card, front side. Press Enter or Space to flip.');
  scene.classList.add('badge-scene--interactive');
  scene.classList.toggle('badge-scene--reduced', reduced);
  render();

  morph.setBadgeFaceHandler((flipped) => setFace(flipped ? 'back' : 'front'));
  badge.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer.id !== -1 || morph.getProgress() > 0.04) return;
    event.preventDefault();
    pointer.id = event.pointerId;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    delete badge.dataset.wasDrag;
    pointer.started = performance.now();
    pointer.lastMove = pointer.started;
    pointer.moved = 0;
    if (!reduced) {
      const local = toLocal(event);
      const center = sim.state().com;
      pointer.grabX = local.x - center.x;
      pointer.grabY = local.y - center.y;
      sim.grab(local.x, local.y);
      dragTarget = center;
      badge.classList.add('is-dragging');
      wake();
    }
    badge.setPointerCapture(event.pointerId);
  });
  badge.addEventListener('pointermove', (event) => {
    if (pointer.id !== event.pointerId) return;
    pointer.moved = Math.max(pointer.moved, Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y));
    if (reduced) return;
    const local = toLocal(event);
    const center = clampToReach({ x: local.x - pointer.grabX, y: local.y - pointer.grabY });
    const now = performance.now();
    sim.dragTo(center.x + pointer.grabX, center.y + pointer.grabY, clamp((now - pointer.lastMove) / 1000, 1 / 240, 1 / 20));
    pointer.lastMove = now;
    dragTarget = center;
    wake();
  });
  badge.addEventListener('pointerup', (event) => endPointer(event, false));
  badge.addEventListener('pointercancel', (event) => endPointer(event, true));
  badge.addEventListener('dragstart', (event) => event.preventDefault());
  motionPreference.addEventListener('change', (event) => {
    reduced = event.matches;
    scene.classList.toggle('badge-scene--reduced', reduced);
    if (pointer.id !== -1) {
      sim.release();
      pointer.id = -1;
      dragTarget = null;
      badge.classList.remove('is-dragging');
    }
    measure();
    flipAngle = flipTarget;
    tiltX = 0;
    tiltY = 0;
    render();
  });
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (pointer.id !== -1) {
        sim.release();
        pointer.id = -1;
        dragTarget = null;
        badge.classList.remove('is-dragging');
      }
      measure();
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      lastTime = 0;
      return;
    }
    // 回到前台：只有视口尺寸真的变了才重新测量。
    // 无条件 measure() 会重建 sim 并清空 dragTarget —— 切个标签页回来就会把
    // 正在进行的拖拽打断（自动化环境里这个事件会频繁触发，表现为"拖不动"）。
    if (window.innerWidth !== measuredViewport.w || window.innerHeight !== measuredViewport.h) {
      measure();
    } else {
      lastAngle = 0;
      wake();
    }
  });

  // 只在从顶部打开时播；刷新停在第二屏、带锚点、减少动态效果都不播
  if (!reduced && window.scrollY < 8 && !window.location.hash) playEntrance(1);

  // 点「Back to badge ↑」回到吊牌时，轻轻回应一下（比入场小）
  document.querySelector<HTMLElement>('[data-return-top]')?.addEventListener('click', () => {
    window.setTimeout(() => {
      if (!reduced && window.scrollY < 8) playEntrance(0.6);
    }, 340);
  });
}
