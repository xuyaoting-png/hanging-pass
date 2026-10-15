// Verlet rope and a heavier card center. Coordinates are local to .badge-scene.
export interface Point {
  x: number;
  y: number;
  ox: number;
  oy: number;
  pinned: boolean;
  w: number;
}

export interface SimOptions {
  segments: number;
  ropeLength: number;
  cordLength: number;
  pinX: number;
  pinY: number;
  gravity: number;
  frictionPerFrame: number;
  chainInvMass: number;
  bendStiffness: number;
  iterations: number;
  fixedDt: number;
  maxSubSteps: number;
  maxAngle: number;
  returnStrength: number;
}

export interface SimState {
  points: Point[];
  clip: { x: number; y: number };
  com: { x: number; y: number };
  angleDeg: number;
  velocity: { x: number; y: number };
  dragging: boolean;
}

const DEFAULTS: SimOptions = {
  segments: 20,
  ropeLength: 382,
  cordLength: 150,
  pinX: 0,
  pinY: -220,
  gravity: 6482,
  frictionPerFrame: 0.976,
  chainInvMass: 0.06,
  bendStiffness: 0.3,
  iterations: 24,
  fixedDt: 1 / 60,
  maxSubSteps: 5,
  maxAngle: 88 * Math.PI / 180,
  returnStrength: 0,
};

export function createSim(options: Partial<SimOptions>) {
  const cfg = { ...DEFAULTS, ...options };
  const pts: Point[] = [];
  let accumulator = 0;
  const drag = { active: false, x: 0, y: 0, vx: 0, vy: 0, offsetX: 0, offsetY: 0 };
  const segmentLength = () => cfg.ropeLength / (cfg.segments - 1);

  for (let i = 0; i < cfg.segments; i++) {
    const y = cfg.pinY + i * segmentLength();
    pts.push({ x: cfg.pinX, y, ox: cfg.pinX, oy: y, pinned: i === 0, w: cfg.chainInvMass });
  }
  const y = pts[cfg.segments - 1].y + cfg.cordLength;
  const com: Point = { x: cfg.pinX, y, ox: cfg.pinX, oy: y, pinned: false, w: 1 };
  pts.push(com);

  function constrain(a: Point, b: Point, length: number, strength = 1): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.hypot(dx, dy) || 1e-4;
    const correction = ((length - distance) / distance) * strength;
    const mx = dx * correction;
    const my = dy * correction;
    const wa = a.pinned ? 0 : a.w;
    const wb = b.pinned ? 0 : b.w;
    const total = wa + wb;
    if (total <= 0) return;
    a.x -= mx * (wa / total);
    a.y -= my * (wa / total);
    b.x += mx * (wb / total);
    b.y += my * (wb / total);
  }

  function integrate(dt: number): void {
    const damping = Math.pow(cfg.frictionPerFrame, dt * 60);
    const gravity = cfg.gravity * dt * dt;
    for (const point of pts) {
      if (point.pinned) continue;
      const vx = (point.x - point.ox) * damping;
      const vy = (point.y - point.oy) * damping;
      point.ox = point.x;
      point.oy = point.y;
      point.x += vx;
      point.y += vy + gravity;
      if (!drag.active) point.x += (cfg.pinX - point.x) * cfg.returnStrength * dt * dt;
    }
    if (drag.active) {
      // 拖拽目标必须落在「绳扣 → 卡片」这段绳长之内：直接瞬移到指针会让
      // |卡 − 扣| 远超 cordLength，求解器一边往回拉、渲染一边跟 → 看着绳卡分离。
      const clip = pts[cfg.segments - 1];
      const pointerDX = drag.x - clip.x;
      const pointerDY = drag.y - clip.y;
      const pointerDist = Math.hypot(pointerDX, pointerDY) || 1;
      const limit = Math.max(1, cfg.cordLength);
      const k = pointerDist > limit ? limit / pointerDist : 1;
      com.x = clip.x + pointerDX * k;
      com.y = clip.y + pointerDY * k;
      com.ox = com.x - drag.vx * dt * k;
      com.oy = com.y - drag.vy * dt * k;
    }
  }

  function solve(): void {
    const length = segmentLength();
    for (let iteration = 0; iteration < cfg.iterations; iteration++) {
      // Drag goes first. The clip-to-COM distance is the final constraint,
      // so a fast pointer cannot pull the visible connector off the card.
      if (drag.active) {
        com.x = drag.x;
        com.y = drag.y;
        com.ox = com.x - drag.vx * cfg.fixedDt;
        com.oy = com.y - drag.vy * cfg.fixedDt;
      }
      for (let i = 0; i < cfg.segments - 1; i++) constrain(pts[i], pts[i + 1], length);
      if (cfg.bendStiffness > 0) {
        for (let i = 1; i < cfg.segments - 1; i++) {
          constrain(pts[i - 1], pts[i + 1], length * 2, cfg.bendStiffness);
        }
      }
      pts[0].x = cfg.pinX;
      pts[0].y = cfg.pinY;
      const clip = pts[cfg.segments - 1];
      const cardAngle = Math.atan2(com.x - clip.x, com.y - clip.y);
      const maxAngle = cfg.maxAngle;
      if (Math.abs(cardAngle) > maxAngle) {
        const safeAngle = Math.max(-maxAngle, Math.min(maxAngle, cardAngle));
        clip.x = com.x - Math.sin(safeAngle) * cfg.cordLength;
        clip.y = com.y - Math.cos(safeAngle) * cfg.cordLength;
      }
      constrain(clip, com, cfg.cordLength);
    }
  }

  function step(dt: number): void {
    if (!(dt > 0)) return;
    accumulator += Math.min(dt, 0.25);
    let count = 0;
    while (accumulator >= cfg.fixedDt && count < cfg.maxSubSteps) {
      integrate(cfg.fixedDt);
      solve();
      accumulator -= cfg.fixedDt;
      count++;
    }
    if (count === cfg.maxSubSteps) accumulator = 0;
  }

  function grab(px: number, py: number): void {
    drag.active = true;
    drag.x = com.x;
    drag.y = com.y;
    drag.vx = 0;
    drag.vy = 0;
    drag.offsetX = px - com.x;
    drag.offsetY = py - com.y;
  }

  function dragTo(px: number, py: number, dt: number): void {
    if (!drag.active) return;
    const x = px - drag.offsetX;
    const y = py - drag.offsetY;
    if (dt > 0) {
      drag.vx = Math.max(-800, Math.min(800, drag.vx * 0.4 + ((x - drag.x) / dt) * 0.6));
      drag.vy = Math.max(-800, Math.min(800, drag.vy * 0.4 + ((y - drag.y) / dt) * 0.6));
    }
    drag.x = x;
    drag.y = y;
  }

  function release(): void { drag.active = false; }

  function setRopeLength(length: number): void {
    if (length > 1) cfg.ropeLength = length;
  }

  function state(): SimState {
    const clip = pts[cfg.segments - 1];
    const dx = com.x - clip.x;
    const dy = com.y - clip.y;
    return {
      points: pts,
      clip: { x: clip.x, y: clip.y },
      com: { x: com.x, y: com.y },
      angleDeg: Math.atan2(dx, dy) * 180 / Math.PI,
      velocity: { x: (com.x - com.ox) / cfg.fixedDt, y: (com.y - com.oy) / cfg.fixedDt },
      dragging: drag.active,
    };
  }

  /**
   * 起摆：绕挂点旋转 theta，并给出匹配的切向速度（omega 为角速度，0 = 从静止放开）。
   * 注意：整体平移整条链不会产生摆动 —— 平移后链条几何不变，重力没有力矩；
   * 必须改变"链子相对挂点的角度"才会摆。
   */
  function swing(theta: number, omega: number): void {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const apply = (p: Point): void => {
      if (p.pinned) return;
      const dx = p.x - cfg.pinX;
      const dy = p.y - cfg.pinY;
      p.x = cfg.pinX + dx * cos - dy * sin;
      p.y = cfg.pinY + dx * sin + dy * cos;
      const vx = -omega * (p.y - cfg.pinY);
      const vy = omega * (p.x - cfg.pinX);
      p.ox = p.x - vx * cfg.fixedDt;
      p.oy = p.y - vy * cfg.fixedDt;
    };
    for (const point of pts) apply(point);
    apply(com);
  }

  return { step, grab, dragTo, release, setRopeLength, state, swing };
}
