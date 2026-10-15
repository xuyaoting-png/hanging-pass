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
// The strap tail must reach inside the clip plate (it used to stop 42px short of the clip,
// leaving the cut end outside it, which read as "not attached")
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
  // Elastic cord: dragging can stretch the rope (up to CORD_STRETCH), and on release an
  // underdamped spring pulls it back to rest length, giving the "pull down -> springs back
  // up" bounce (ζ≈0.35, so it oscillates a few times before settling).
  const CORD_STRETCH = 0.28;
  const ROPE_SPRING = 150;
  const ROPE_DAMPING = 12;    // 8.5 → 12: settles the drop-and-bounce faster
  let ropeLength = 0;
  let ropeVelocity = 0;
  // Entrance (conservative preset): pre-stretch the cord a little so it drops and bounces
  // back on its own, then add a lateral impulse to sway left and right, decaying to rest in
  // about 4s. These three numbers are meant to be tweaked directly.
  // dx/dy = push distance (it sways back naturally); ropeStretch = cord pre-stretch
  // (drop and bounce)
  // angle = start swing angle (rad), ~0.03 rad ≈ 20px (total pendulum length 665px);
  // ropeStretch = cord pre-stretch
  // Mimics "a person grabs it once and lets go": pulled down (cord stretches) → bounces
  // back → one flick, then a few left-right swings.
  // Gotcha (learned the hard way): too strong an impulse exceeds what the PBD solver can
  // correct in a single step -- the rope gets stretched and the card looks "detached" from
  // the strap. So this uses a "clearly visible but not violent" magnitude:
  //   ropeStretch 0.08 ≈ 30px vertical; angle 0.025 + omega 0.1 ≈ 60–70px lateral
  const ENTRANCE = { ropeStretch: 0.075, angle: 0.035, omega: 0.14 };  // 25% smaller overall
  // Layout jitter within 1.2s of the entrance triggers measure(), which rebuilds the sim
  // and wipes the impulse -- so a rebuild inside this window re-fires it once, and never
  // replays it after that.
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
  // Pixel label: one <g> per glyph built from the font bitmap (built once), each frame
  // only writes transform
  // Twisted ribbon shading: 24 quads (built once, each frame only rewrites d and opacity)
  const RIBBON_STEPS = 24;
  const shadeQuads: SVGPathElement[] = [];
  for (let i = 0; i < RIBBON_STEPS; i++) {
    const quad = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    quad.setAttribute('fill', '#26382b');
    quad.setAttribute('opacity', '0');
    strapShade?.appendChild(quad);
    shadeQuads.push(quad);
  }

  // The 3D ribbon (Three.js) takes over the strap and the print; the SVG band/highlight/
  // thread/pixel-label set is hidden
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
      // Double the substeps: a long chain needs more of them, otherwise big impulses
      // outrun what the constraints can fix (rope stretches / card flung out)
      fixedDt: 1 / 120,
      frictionPerFrame: 0.9915,   // 0.99 → 0.988: sway decays faster and settles
      chainInvMass: 0.06,
      bendStiffness: 0.45,        // 0.3 → 0.45: stiffer strap, no mush while dragging
      maxAngle: maxVisibleAngle,
      returnStrength: 12,
    });
    lastAngle = 0;
    dragTarget = null;
    // Visible rope length: the y ≥ 0 part of the polyline (the pin end is off-screen)
    let visibleRope = 0;
    const pts = sim.state().points;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y < 0 || pts[i - 1].y < 0) continue;
      visibleRope += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    // The texture length must use the **polyline's true arc length** (that is exactly what
    // the UVs cover), not baseRopeLength + cordLength
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
    // The cap must include the cord's stretch, or the pointer cannot reach the pulled-down
    // part
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
    // First parse the d we just wrote back into a polyline (ribbon, pixel label and clip
    // rotation all read this one copy, so they stay from the same source)
    const polyline: { x: number; y: number }[] = [];
    for (const match of path.matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
      polyline.push({ x: Number(match[2]), y: Number(match[3]) });
    }

    // Twisted ribbon: Φ = sin(flip angle) × 90° -- max twist mid-flip, zero on both faces
    // (what the user asked for: "tap to flip to the back + the whole lanyard twists once,
    // tap again to undo")
    // Half a turn (150°) = the reference image's "wide top → thin middle → wide bottom" twist.
    // Twist follows screen y: 0° at the top of the visible span → 150° at the bottom
    // (thinnest as it passes 75°)
    const twist = twistEnvelope(flipAngle, 150);
    const clipY = polyline.length ? polyline[polyline.length - 1].y : 0;
    // 3D ribbon: a true half turn (everything below the knot turns to the back; self-
    // occlusion comes from z depth)
    ribbon3d?.update(polyline, twistEnvelope(flipAngle, 180));
    const ribbon = sampleRibbon(polyline, twist, RIBBON_STEPS, 6, clipY);
    const halfWidth = 17;
    strapBand.setAttribute('d', ribbonOutline(ribbon, halfWidth));
    const quads = ribbonQuads(ribbon, halfWidth);
    const avgFacing = ribbon.reduce((sum, r) => sum + r.facing, 0) / Math.max(1, ribbon.length);
    for (let i = 0; i < shadeQuads.length; i++) {
      const quad = quads[i];
      // Paint the whole ribbon with the opaque interpolated colour: no translucent layers
      // on top any more, so no phantom "shadow at the knot"
      shadeQuads[i].setAttribute('d', quad ? quad.d : '');
      shadeQuads[i].setAttribute('fill', quad ? quad.fill : 'none');
      shadeQuads[i].setAttribute('opacity', quad ? '1' : '0');
    }
    const line = centerlinePath(ribbon);
    // The highlight must also be a "ribbon that narrows with the twist": a fixed-width
    // stroke turns into a floating separate bar once it edges past the view
    strapHighlight.setAttribute('d', ribbonBandPath(ribbon, halfWidth * 0.58));
    strapHighlight.setAttribute('fill', '#718570');
    strapHighlight.setAttribute('stroke', 'none');
    strapHighlight.setAttribute('opacity', '1');
    strapThread.setAttribute('d', line);
    strapThread.setAttribute('opacity', ((1 - avgFacing) * 0.85).toFixed(3));
    strapWeave?.setAttribute('d', path);
    strapWeave?.setAttribute('opacity', '0');
    // Label: parse the same d just written (so it shares the strap's exact source and
    // frame), then place each glyph along the arc length
    const poses = layoutLabel(polyline, LABEL_TEXT, { pixel: LABEL_PIXEL, visibleTop: 6, bottomReserve: 34 });
    for (let i = 0; i < labelGlyphs.length && i < poses.length; i++) {
      const pose = poses[i];
      // Squeeze the glyphs as the strap turns edge-on -- must use the same reference as the
      // ribbon (screen y), otherwise glyphs and strap twist out of step
      const glyphK = Math.max(0, Math.min(1, (pose.y - 6) / Math.max(1, clipY - 6)));
      // When the strap turns edge-on, what squashes is the "strap width direction" = the
      // glyph's y axis (not its x axis)
      const knot = Math.exp(-Math.pow((glyphK - 0.42) / 0.17, 2));
      const facing = 1 - Math.max(0, Math.min(1, Math.abs(twist) / Math.PI)) * knot;
      // Below the knot you see the "back" of the print → mirror along the strap width
      // (that is what "flipped to the back" reads as)
      const mirrored = glyphK > 0.42 && Math.abs(twist) > 0.25;
      labelGlyphs[i].setAttribute(
        'transform',
        `translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) rotate(${pose.angle.toFixed(2)}) scale(${LABEL_PIXEL} ${(LABEL_PIXEL * Math.max(0.08, facing) * (mirrored ? -1 : 1)).toFixed(3)}) translate(${-GLYPH_W / 2} ${-GLYPH_H / 2})`,
      );
    }

    // CSS/SVG rotate() must receive the negative of the physical angle.
    const rotation = -state.angleDeg;
    // The clip plate is rigid, the strap is a curve: using the "tail tangent" leaves the
    // plate a few degrees off the strap mouth, and on a 37px lever that pushes the 34px-wide
    // strap out through the side of the 46px-wide plate.
    // So take the strap direction at the "plate mouth height" (walk back PLATE_HEIGHT along
    // the polyline).
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
    // On a flip the lanyard "flips along": twist the whole strap about the clip point,
    // peaking mid-flip and returning to zero on both faces.
    // Uses a sin envelope (0°→0, 90°→peak, 180°→0), so no skewed strap is left on either face.
    // The twist above is the "real ribbon twist" (radians). Here we also give the whole rig a
    // slight tilt (the hardware leans with it), at 1/4 of the twist amplitude -- the ribbon
    // carries the effect and the rig only assists.
    // The cord must stay on the vertical and "twist in place": no rigid rotation of the whole
    // rig (that would turn into a sideways swing)
    const rigTwist = 0;
    if (strapRig) {
      strapRig.style.transformOrigin = `${clipPoint.x.toFixed(2)}px ${clipPoint.y.toFixed(2)}px`;
      strapRig.style.setProperty('--strap-twist', `${rigTwist.toFixed(3)}deg`);
    }
    // Hardware flips with the card: fake rotateY by squashing horizontally (the origin is
    // the clip point, so scale from the local origin)
    const flipScale = Math.max(0.12, Math.abs(Math.cos((flipAngle * Math.PI) / 180)));
    clip.setAttribute('transform', `translate(${clipPoint.x.toFixed(3)} ${clipPoint.y.toFixed(3)}) rotate(${(tailAngle - 90 + rigTwist).toFixed(4)}) scale(${flipScale.toFixed(3)} 1)`);
    ring.setAttribute('transform', `translate(${clipPoint.x.toFixed(3)} ${clipPoint.y.toFixed(3)}) rotate(${(rotation + rigTwist * 0.6).toFixed(4)}) scale(${flipScale.toFixed(3)} 1)`);
    // Card pose: written only by lanyard-morph during the morph (two loops writing at once
    // would overwrite each other); at progress≈0 physics still writes it, so rest and drag
    // stay physics-driven.
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
        // After release: the damped spring pulls the cord back to rest length -- this step
        // is what produces the "springs back up" bounce
        const acc = (baseRopeLength - ropeLength) * ROPE_SPRING - ropeVelocity * ROPE_DAMPING;
        ropeVelocity += acc * dt;
        ropeLength += ropeVelocity * dt;
      }
      sim.setRopeLength(ropeLength);
      if (morph.getProgress() <= 0.04) sim.step(dt);
      const state = sim.state();
      // Shrink the 3D tilt caps: at the old ±30°/±42° a big swing made the card look
      // "flung off/detached"; now ±9°/±12° -- still "the card is swaying", but never
      // visually severed.
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
   * Entrance impulse. scale gives the "back to badge" case a smaller version.
   * Only fires on the first screen, without reduced motion, and while the user is not dragging.
   */
  function fireEntrance(scale: number): void {
    const narrow = window.innerWidth <= 760;
    // Strap length = 0.62 × viewport height: 457px at 738 high, 882px at 1490 high.
    // Same segment count with each segment twice as long → the long chain acts softer, so
    // the same impulse stretches the rope and flings the card out.
    // So scale the impulse inversely with rope length: the visual amplitude stays consistent
    // across window sizes and stays inside the solver's stable range.
    const ropeScale = Math.min(1, Math.max(0.62, 457 / Math.max(1, baseRopeLength)));
    const k = scale * (narrow ? 0.7 : 1) * ropeScale;
    ropeLength = baseRopeLength * (1 + ENTRANCE.ropeStretch * k);
    ropeVelocity = 0;
    sim.setRopeLength(ropeLength);
    // Released from rest to one side: gravity torque drives the swing, damping stops it in
    // about 4s
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
      // No longer snapping the cord back to rest length instantly: let the damped spring
      // bounce it (that is the "pull it down and it springs up" feel)
      sim.release();
    }
    badge.classList.remove('is-dragging');
    if (badge.hasPointerCapture(event.pointerId)) badge.releasePointerCapture(event.pointerId);
    const click = !canceled && pointer.moved < 6 && performance.now() - pointer.started < 400;
    // Browsers still dispatch click after a drag -- so flag it here and let morph decide
    // "no flip". Short press (<6px and <400ms) = flip; long press / release after a drag =
    // no flip.
    if (!click) badge.dataset.wasDrag = '1';
    pointer.id = -1;
    dragTarget = null;
    // Flipping is decided solely by lanyard-morph's flipIndex (flipping again here would
    // cancel it out)
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
    // Back to foreground: only re-measure when the viewport size really changed.
    // An unconditional measure() rebuilds the sim and clears dragTarget -- switching tabs
    // and back would interrupt an in-progress drag (automation environments fire this event
    // constantly, which shows up as "cannot drag").
    if (window.innerWidth !== measuredViewport.w || window.innerHeight !== measuredViewport.h) {
      measure();
    } else {
      lastAngle = 0;
      wake();
    }
  });

  // Only plays when opened from the top; a refresh parked on screen two, a hash anchor, or
  // reduced motion all skip it
  if (!reduced && window.scrollY < 8 && !window.location.hash) playEntrance(1);

  // Clicking "Back to badge ↑" to return to the badge answers softly (smaller than the
  // entrance)
  document.querySelector<HTMLElement>('[data-return-top]')?.addEventListener('click', () => {
    window.setTimeout(() => {
      if (!reduced && window.scrollY < 8) playEntrance(0.6);
    }, 340);
  });
}
