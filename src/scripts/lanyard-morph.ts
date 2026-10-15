type Pose = {
  x: number;
  y: number;
  z: number;
  rotZ: number;
  scale: number;
  opacity: number;
};

type BadgeSnapshot = {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  angle: number;
  velocityX: number;
  velocityY: number;
};

type CardRef = { element: HTMLElement; tilt: HTMLElement; index: number };
type Point = { x: number; y: number };

export type LanyardMorphController = {
  update(snapshot: BadgeSnapshot): void;
  getProgress(): number;
  setBadgeFaceHandler(handler: (flipped: boolean) => void): void;
  setPhysicsResumeHandler(handler: () => void): void;
  getDebugState(): Readonly<Record<string, unknown>>;
};

// Card entrance params are generated from the real card count (count = static cards in the
// DOM + 1 badge cover). To add or remove cards just edit src/data/cards.ts; no need to
// hand-write 7 sets of numbers here.
type CardParams = { enter: [number, number]; arc: number };
// Carousel "slides" exclude the cover (the badge at index 0): the cover only flies out and
// fades away.
// slide s ↔ DOM data-chapter-index = s + 1
let slideCount = 1;
let cardParams: CardParams[] = [{ enter: [0.02, 0.66], arc: -52 }];

function buildCardParams(count: number): CardParams[] {
  return Array.from({ length: count }, (_, i) => ({
    enter: [Math.min(0.02 + i * 0.045, 0.34), Math.min(0.62 + i * 0.05, 0.94)] as [number, number],
    arc: clamp(-52 + i * 20, -70, 70),
  }));
}

const COVER = {
  // Left stage + right panel: horizontal anchor for the active card (fraction of the
  // viewport width); the right 360px is given to the info panel
  anchorRatio: 0.32,
  spacing: 238,
  // Spacing = real card width × this ratio. This site's card is clamp(244px, 21vw, 292px),
  // so a hard-coded spacing ends up narrower than the card on wide screens (neighbours
  // overlap) and differs per breakpoint.
  spacingRatio: 1.12,
  // Depth kept small: the larger z is, the more perspective pulls back-row cards toward the
  // vanishing point (at 170 the whole row was 7px off and looked crooked)
  depth: 60,
  // No tilt: cards stay vertical (rotate 1.6 used to leave the left and right ones askew)
  rotate: 0,
  scaleStep: 0.085,
  // Only the active card + 1 on each side stay clearly visible; the 2nd fades to almost
  // nothing (otherwise it reaches under the right panel)
  fadeStep: 0.95,
  // No vertical offset and no "lift" on the active card (liftZ pushes it down under
  // perspective; the whole row was 9px off)
  yStep: 0,
  liftZ: 0,
  overshoot: 0.05,
};

// Panel text changes as the card changes, so slow the drift to 7s/card (2.8s was too noisy)
const AUTO = { onHover: true, always: false, secondsPerCard: 7, resumePauseAfterMs: 9000 } as const;

// Adaptive scale and vertical centre for the card row: written by measureRowFit().
// Available height = the band between the chapter header bottom → controls top; a 441px card
// does not fit vertically, and without scaling it would both cover the header and be covered
// by the controls.
// Morph range (the scroll distance needed for screen two to settle), measured in
// measureRowFit; must be declared at module scope
let morphRange = 0;
let rowScale = 1;
let rowCenterY = 0;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutBack = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c1 = 0.9 + COVER.overshoot * 12;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const span = (value: number, range: readonly [number, number]) =>
  clamp((value - range[0]) / Math.max(1e-4, range[1] - range[0]), 0, 1);

if (easeOutBack(0) !== 0 || easeOutBack(1) !== 1) {
  throw new Error('Lanyard morph easing endpoints must be 0 and 1.');
}

// Looping carousel: indices and poses both use the "shortest wrap distance", so after the
// last card it wraps back to the first
function wrapIndex(value: number): number {
  const total = slideCount || 1;
  return ((value % total) + total) % total;
}

function loopOffset(index: number, center: number): number {
  const total = slideCount || 1;
  let d = (index - center) % total;
  if (d > total / 2) d -= total;
  if (d < -total / 2) d += total;
  return d;
}

function targetPose(index: number, carIndex: number, spacing: number): Pose {
  const distance = loopOffset(index, carIndex);
  const depth = Math.abs(distance);
  return {
    x: distance * spacing * rowScale,
    y: depth * COVER.yStep * rowScale,
    z: -depth * COVER.depth + (depth < 0.001 ? COVER.liftZ : 0),
    rotZ: distance * COVER.rotate,
    scale: Math.max(0.5, 1 - depth * COVER.scaleStep) * rowScale,
    opacity: Math.max(0, 1 - Math.max(0, depth - 1) * COVER.fadeStep),
  };
}

function morphPose(index: number, progress: number, from: Pose, carIndex: number, spacing: number): Pose {
  const card = cardParams[index] ?? cardParams[cardParams.length - 1];
  const t = span(progress, card.enter);
  const eased = easeInOutSine(t);
  const to = targetPose(index, carIndex, spacing);
  // The cover (badge) no longer comes through here -- it fades out separately in draw().
  // So every slide takes off from a pose "hidden behind the badge": opacity 0, slightly
  // offset, slightly scaled down.
  // index + 1 is used here to stay consistent with the original data-chapter-index offset.
  const start: Pose = {
    x: from.x - (index + 1) * 14,
    y: from.y + (index + 1) * 10,
    z: -(index + 1) * 46,
    rotZ: from.rotZ,
    scale: 0.94,
    opacity: 0,
  };
  const dx = to.x - start.x;
  const dy = to.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const arc = Math.sin(Math.PI * t) * card.arc;
  return {
    x: lerp(start.x, to.x, eased) - dy / length * arc,
    y: lerp(start.y, to.y, eased) + dx / length * arc,
    z: lerp(start.z, to.z, eased),
    rotZ: lerp(start.rotZ, to.rotZ, eased),
    scale: lerp(start.scale, to.scale, eased),
    opacity: lerp(start.opacity, to.opacity, easeInOutCubic(t)),
  };
}

export function initLanyardMorph(): LanyardMorphController | null {
  const plane = document.querySelector<HTMLElement>('[data-morph-plane]');
  const scene = document.querySelector<HTMLElement>('.badge-scene');
  const badge = scene?.querySelector<HTMLElement>('.badge-card');
  const runway = document.querySelector<HTMLElement>('#runway');
  const chapterStage = document.querySelector<HTMLElement>('#screen2');
  const staticCards = Array.from(document.querySelectorAll<HTMLElement>('[data-chapter-grid] [data-morph-card]'));
  const controls = document.querySelector<HTMLElement>('[data-chapter-controls]');
  const label = document.querySelector<HTMLElement>('[data-carousel-label]');
  const count = document.querySelector<HTMLElement>('[data-carousel-count]');
  const dots = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-carousel-dot]'));
  const debug = document.querySelector<HTMLElement>('[data-morph-debug]');
  if (!plane || !scene || !badge || !runway || !chapterStage || staticCards.length < 1 || !controls || !label || !count) return null;

  slideCount = staticCards.length;
  cardParams = buildCardParams(slideCount);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const showDebug = new URLSearchParams(window.location.search).get('debug') === '1';
  if (debug) debug.hidden = !showDebug;

  const cards: CardRef[] = [{
    element: badge,
    tilt: badge.querySelector<HTMLElement>('.badge-tilt')!,
    index: 0,
  }];
  if (cards[0].tilt) {
    for (const cardElement of staticCards) {
      const index = Number(cardElement.dataset.chapterIndex);
      const tilt = document.createElement('div');
      tilt.className = 'chapter-card__tilt';
      while (cardElement.firstChild) tilt.appendChild(cardElement.firstChild);
      cardElement.appendChild(tilt);
      plane.appendChild(cardElement);
      cards.push({ element: cardElement, tilt, index });

      // Content cards no longer flip: the description and the jump-in link live permanently
      // in the right panel (one whole state machine fewer)
      cardElement.addEventListener('focusin', () => {
        if (canInteract()) setTarget(index - 1);
      });
    }
  } else return null;

  // Moving these layers to a fixed viewport plane keeps their starting position
  // identical at scroll=0 while allowing the same cards to cross both sections.
  plane.appendChild(scene);
  plane.hidden = false;
  document.documentElement.classList.add('morph-ready');

  // Card sizes are measured once during measure: reading offsetWidth/offsetHeight every frame
  // in draw() would waste layout work
  const cardSizes = new Map<number, { width: number; height: number }>();
  function measureCards(): void {
    for (const card of cards) {
      cardSizes.set(card.index, { width: card.element.offsetWidth, height: card.element.offsetHeight });
    }
  }
  measureCards();

  function measureRowFit(): void {
    const header = chapterStage.querySelector<HTMLElement>('.chapter-stage__header');
    const controls = document.querySelector<HTMLElement>('[data-chapter-controls]');
    const cardHeight = cardSizes.get(0)?.height ?? 0;
    if (!cardHeight) return;
    // The controls moved into the right panel, so the reference is now "header bottom →
    // layout bottom" (leaving 64px of breathing room)
    const narrow = window.innerWidth <= 760;
    const top = header ? header.offsetTop + header.offsetHeight + 10 : 0;
    const bottom = chapterStage.clientHeight - 64;
    const band = Math.max(220, bottom - top);
    rowScale = clamp((band - 28) / cardHeight, 0.5, 1);
    rowCenterY = top + band / 2;
    // Exposed to CSS so the panel can align vertically with the card row (otherwise one
    // centres at 50% and the other at 58%, which reads as misaligned)
    chapterStage.style.setProperty('--row-center', `${Math.round(rowCenterY)}px`);
    // Morph range: distance needed to scroll screen two's top to the viewport top (absolute
    // position, to avoid offsetParent differences)
    morphRange = Math.round(chapterStage.getBoundingClientRect().top + window.scrollY);
    if (morphRange < 200) morphRange = Math.round(window.innerHeight + runway.offsetHeight);
    if (narrow) {
      // Narrow screens: the panel is pinned to the bottom, so shift the card row up and scale
      // it down slightly to keep them from overlapping
      rowScale = Math.min(rowScale, 0.92);
      rowCenterY = chapterStage.clientHeight * 0.36;
    }
  }

  measureRowFit();

  // Horizontal spacing between neighbouring cards: follows the real card width, so it stays
  // consistent at every breakpoint
  function coverSpacing(): number {
    const cardWidth = cardSizes.get(0)?.width ?? COVER.spacing;
    return Math.min(cardWidth * COVER.spacingRatio, window.innerWidth * 0.72);
  }

  const rigLayer = scene.querySelector<SVGElement>('.badge-rig:not(.badge-rig--front)');
  const rigFrontLayer = scene.querySelector<SVGElement>('.badge-rig--front');

  let snapshot: BadgeSnapshot | null = null;
  let progress = 0;
  let panelProgress = 0;
  let carIndex = 0;
  let carTarget = 0;
  let frameId = 0;
  let tween: { from: number; to: number; start: number; duration: number } | null = null;
  let badgeFaceHandler: (flipped: boolean) => void = () => {};
  // Flip state: only the card near carIndex may be flipped open; leaving the centre resets it
  let flipIndex: number | null = null;
  let pendingFlip: number | null = null;
  let physicsResumeHandler = () => {};
  // Unclip: as soon as scrolling starts, the hook rotates out around the O-ring centre (the
  // first beat of the transition)
  const rigHook = scene?.querySelector<SVGGElement>('[data-rig-hook]');
  const ribbonCanvas = scene?.querySelector<HTMLCanvasElement>('[data-strap-ribbon3d]');
  let currentLabel = '';
  // Right info panel: fields are read from the card DOM's data-* (single source of truth =
  // src/data/cards.ts)
  const panelBody = document.querySelector<HTMLElement>('[data-panel-body]');
  const panelTitle = document.querySelector<HTMLElement>('[data-panel-title]');
  const panelMeta = document.querySelector<HTMLElement>('[data-panel-meta]');
  const panelSummary = document.querySelector<HTMLElement>('[data-panel-summary]');
  const panelList = document.querySelector<HTMLElement>('[data-panel-list]');
  const panelCta = document.querySelector<HTMLAnchorElement>('[data-panel-cta]');
  const panelCtaText = document.querySelector<HTMLElement>('[data-panel-cta-text]');
  let panelIndex = -1;
  let panelSwap = 0;

  function updatePanel(slide: number): void {
    if (slide === panelIndex || !panelBody) return;
    panelIndex = slide;
    const el = cards.find((card) => card.index === slide + 1)?.element;
    if (!el) return;
    const apply = (): void => {
      if (panelTitle) {
        panelTitle.textContent = el.dataset.cardTitle ?? '';
        const dot = document.createElement('span');
        dot.textContent = '.';
        panelTitle.appendChild(dot);
      }
      if (panelMeta) panelMeta.textContent = el.dataset.cardMeta ?? '';
      if (panelSummary) panelSummary.textContent = el.dataset.cardSummary ?? '';
      if (panelList) {
        panelList.textContent = '';
        let bullets: unknown = [];
        try { bullets = JSON.parse(el.dataset.cardBullets ?? '[]'); } catch { bullets = []; }
        for (const bullet of Array.isArray(bullets) ? bullets : []) {
          const li = document.createElement('li');
          li.textContent = String(bullet);
          panelList.appendChild(li);
        }
      }
      if (panelCta && el.dataset.cardHref) panelCta.href = el.dataset.cardHref;
      if (panelCtaText) panelCtaText.textContent = el.dataset.cardCta ?? '';
    };
    // Cross-fade: fade out first, then swap the text (the DOM only changes on switch, no
    // per-frame writes)
    panelBody.classList.add('is-switching');
    window.clearTimeout(panelSwap);
    panelSwap = window.setTimeout(() => {
      apply();
      panelBody.classList.remove('is-switching');
    }, 140);
  }
  let currentActiveIndex = -1;
  let lastFrameTime = 0;
  let frameWork = 0;
  let worstFrame = 0;
  let frameCount = 0;
  let fpsWindowStart = performance.now();
  let fpsValue = 0;
  let debugUpdateTime = 0;
  const drift = { hover: false, pause: false, direction: 1, wasPaused: false, pausedAt: 0 };
  const pointer: {
    id: number;
    x: number;
    y: number;
    moved: number;
    axis: 'x' | 'y' | null;
    index: number;
    startIndex: number;
    lastX: number;
    velocity: number;
  } = { id: -1, x: 0, y: 0, moved: 0, axis: null, index: 0, startIndex: 0, lastX: 0, velocity: 0 };

  // Morph range = the scroll distance that puts screen two exactly at the top of the viewport.
  // It used to be runway height (80vh), so cards settled at 590px while screen two only
  // settled at 1328px -- across those 738px the header swept over the fixed-layer cards
  // (a refresh parked there looked like "image and header overlapping").
  function morphLength(): number {
    return morphRange || Math.max(runway.offsetHeight, window.innerHeight * 0.8);
  }

  function scrollToY(target: number): void {
    tween = { from: window.scrollY, to: target, start: performance.now(), duration: reducedMotion.matches ? 0 : 620 };
    requestFrame();
  }

  function requestFrame(): void {
    if (!frameId && !document.hidden) frameId = requestAnimationFrame(frame);
  }

  function updateProgress(): void {
    const previousProgress = progress;
    const length = morphLength();
    progress = clamp(window.scrollY / length, 0, 1);
    // The fade-in window narrows with the remaining scrollable distance and snaps to 1 at the
    // bottom -- otherwise the panel/watermark stops on "almost there" values like 0.988.
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    // The panel fades in over the last stretch (after the cards have mostly settled), to
    // avoid crossing paths with cards still in flight
    const panelWindow = clamp(length * 0.16, 140, 260);
    // The fade-in window must start one panelWindow earlier, otherwise everything pops in on
    // the very last frame
    panelProgress = window.scrollY >= maxScroll - 2 ? 1 : clamp((window.scrollY - (length - panelWindow)) / panelWindow, 0, 1);
    const panelOpacity = easeInOutCubic(panelProgress);
    const root = document.documentElement;
    root.style.setProperty('--morph-chrome', String(1 - easeInOutCubic(span(progress, [0, 0.3]))));
    root.style.setProperty('--morph-panel', panelOpacity.toFixed(3));
    root.style.setProperty('--morph-next', (easeInOutCubic(span(progress, [0.1, 0.5])) * (1 - panelOpacity)).toFixed(3));
    // Identity content fades out first and chapter content fades in after, with no overlap --
    // otherwise you would briefly see a translucent face/name and the chapter list stacked on
    // one card ("ghosting").
    // Card 0 is now the About Me cover (the front identity is always visible), so the
    // "identity → chapter" cross-fade is no longer needed
    plane.classList.toggle('morph-plane--carousel', panelProgress > 0.85);
    scene.classList.toggle('is-morph-locked', progress > 0.04);
    if (previousProgress > 0.04 && progress <= 0.04) physicsResumeHandler();
    // Flip the badge back to its front as soon as scrolling starts: otherwise it flies
    // through the transition showing its back (the motto), duplicating HELLO. on the same
    // screen.
    // The "0 → >0" crossing test also resets it when you jump straight to the bottom
    // (crossing in a single frame).
    if (previousProgress <= 0.001 && progress > 0.001 && flipIndex === 0) setFlip(null);
  }

  // Cards slide out from under the pointer, so pointerover/pointerout misreads hover as
  // "left" and the drift stops after one card. Instead test geometry: is the pointer inside
  // the card row's bounds?
  let pointerX = -1;
  let pointerY = -1;
  document.addEventListener('pointermove', (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
  }, { passive: true });

  function pointerOverRow(): boolean {
    if (pointerX < 0 || !snapshot) return false;
    const halfRow = coverSpacing() * rowScale * 2.2;
    const halfHeight = ((cardSizes.get(0)?.height ?? 420) * rowScale) * 0.62;
    const centerX = snapshot.width / 2;
    const centerY = rowCenterY || snapshot.height / 2;
    return Math.abs(pointerX - centerX) <= halfRow && Math.abs(pointerY - centerY) <= halfHeight;
  }

  function isCentered(index: number): boolean {
    return Math.abs(index - carIndex) < 0.55;
  }

  // The carousel only becomes interactive once the panel is up (same threshold as dragging)
  function canInteract(): boolean {
    return panelProgress >= 0.85;
  }

  function setFlip(next: number | null): void {
    // Content cards pass data-chapter-index (≥1), slide = index - 1; the cover is only valid
    // on the first screen
    const value = next === null ? null : next === 0 ? (progress <= 0.5 ? 0 : null) : (isCentered(next - 1) ? next : null);
    if (value === flipIndex) return;
    const previous = flipIndex;
    flipIndex = value;
    for (const card of cards) {
      if (card.index === 0) continue;
      card.element.classList.toggle('is-flipped', card.index === value);
    }
    if (value === 0) badgeFaceHandler(true);
    else if (previous === 0) badgeFaceHandler(false);
  }

  function toggleFlip(index: number): void {
    // The badge (index 0) can flip on both screens: the motto on screen one, the cover back +
    // "More about me" on screen two
    if (index === 0) {
      // The cover (badge) is only flippable on the first screen; it has faded out on screen two
      if (progress > 0.5) return;
      setFlip(flipIndex === 0 ? null : 0);
      return;
    }
    if (!canInteract()) return;
    // Content card: click = snap to centre (no more flipping; description and link live in
    // the right panel)
    setTarget(index - 1);
  }

  function draw(): void {
    if (!snapshot) return;
    updateProgress();
    // Reset once off centre, so a flipped card does not "wander through the queue" (the cover
    // is only valid on the first screen)
    const flipValid = flipIndex === null || (flipIndex === 0 ? progress <= 0.5 : isCentered(flipIndex - 1));
    if (flipIndex !== null && !flipValid) setFlip(null);
    if (pendingFlip !== null && Math.round(carIndex) === pendingFlip) {
      const index = pendingFlip;
      pendingFlip = null;
      setFlip(index);
    }
    const { width, height } = snapshot;
    // Stage anchor: horizontal reference for the active card (it used to be the viewport
    // centre; now shifted left to make room for the right panel)
    const centerX = width * COVER.anchorRatio;
    const centerY = rowCenterY || height / 2;
    const spacing = coverSpacing();
    const from: Pose = {
      x: snapshot.centerX - centerX,
      y: snapshot.centerY - centerY,
      z: 0,
      rotZ: snapshot.angle,
      scale: 1,
      opacity: 1,
    };
    // Unclip: between 0.008 → 0.10 rotate the hook out 42° and lift it 7px (done after a tiny
    // bit of scrolling, so it reads as "I undo it first")
    if (rigHook) {
      const release = easeInOutCubic(span(progress, [0.008, 0.1]));
      rigHook.setAttribute('transform', `rotate(${(release * 42).toFixed(2)}) translate(0 ${(-release * 7).toFixed(2)})`);
    }
    const strapProgress = easeOutBack(span(progress, [0.03, 0.5]));
    const strapVisible = strapProgress < 0.995;
    for (const element of [rigLayer, rigFrontLayer, ribbonCanvas]) {
      if (!element) continue;
      element.style.visibility = strapVisible ? 'visible' : 'hidden';
      if (strapVisible) {
        element.style.opacity = String((element === rigFrontLayer ? 1 - span(progress, [0, 0.14]) : 1) * (1 - strapProgress));
        // Append --strap-twist here: the slight twist of the lanyard during a flip (computed by
        // lanyard-pass)
        element.style.transform = `translateY(${-strapProgress * height * 0.62}px) rotate(var(--strap-twist, 0deg))`;
      }
    }

    for (const card of cards) {
      const size = cardSizes.get(card.index);
      const cardWidth = size ? size.width : card.element.offsetWidth;
      const cardHeight = size ? size.height : card.element.offsetHeight;

      // Cover (the badge at index 0): not part of the carousel; flies out and fades at the same
      // time
      if (card.index === 0) {
        const exit = easeInOutCubic(span(progress, [0.3, 0.7]));
        if (progress > 0.001) {
          card.element.style.transform = `translate3d(${(centerX - cardWidth / 2 + from.x).toFixed(2)}px, ${(centerY - cardHeight / 2 + from.y - exit * 46).toFixed(2)}px, ${(-exit * 140).toFixed(2)}px) rotate(${from.rotZ.toFixed(3)}deg) scale(${(1 - exit * 0.06).toFixed(4)})`;
          card.element.style.opacity = (1 - exit).toFixed(3);
          card.element.style.pointerEvents = exit > 0.08 ? 'none' : '';
          card.element.style.zIndex = '4';
        }
        continue;
      }

      const slide = card.index - 1;
      const pose = morphPose(slide, progress, from, carIndex, spacing);
      const transform = `translate3d(${(centerX - cardWidth / 2 + pose.x).toFixed(2)}px, ${(centerY - cardHeight / 2 + pose.y).toFixed(2)}px, ${pose.z.toFixed(2)}px) rotate(${pose.rotZ.toFixed(3)}deg) scale(${pose.scale.toFixed(4)})`;
      card.element.style.transform = transform;
      card.tilt.style.transform = `rotateX(${(-snapshot.velocityY * (1 - span(progress, [0, 0.16])) * 0.008).toFixed(2)}deg) rotateY(${(-snapshot.velocityX * (1 - span(progress, [0, 0.16])) * 0.012).toFixed(2)}deg)`;
      card.element.style.opacity = pose.opacity.toFixed(3);
      card.element.style.zIndex = String(Math.max(0, 80 - Math.round(Math.abs(slide - carIndex) * 18)));
      const hidden = String(pose.opacity < 0.04);
      if (card.element.getAttribute('aria-hidden') !== hidden) card.element.setAttribute('aria-hidden', hidden);
    }
    if (label && count) {
      const activeSlide = wrapIndex(Math.round(carIndex));
      // slide s ↔ data-chapter-index = s + 1 (the cover is not in the carousel)
      const activeLabel = cards.find((card) => card.index === activeSlide + 1)?.element.dataset.cardLabel ?? '';
      if (currentLabel !== activeLabel) {
        currentLabel = activeLabel;
        label.textContent = activeLabel;
        count.textContent = `${String(activeSlide + 1).padStart(2, '0')} / ${String(slideCount).padStart(2, '0')}`;
      }
      updatePanel(activeSlide);
      if (currentActiveIndex !== activeSlide) {
        currentActiveIndex = activeSlide;
        dots.forEach((dot) => dot.setAttribute('aria-current', String(Number(dot.dataset.carouselDot) === activeSlide)));
      }
    }
  }

  function frame(time: number): void {
    frameId = 0;
    if (document.hidden) return;
    const start = performance.now();
    const dt = clamp(lastFrameTime ? (time - lastFrameTime) / 1000 : 1 / 60, 1 / 240, 1 / 30);
    lastFrameTime = time;

    if (tween) {
      const t = clamp((time - tween.start) / Math.max(1, tween.duration), 0, 1);
      const eased = easeInOutCubic(t);
      window.scrollTo(0, tween.from + (tween.to - tween.from) * eased);
      if (t >= 1) {
        window.scrollTo(0, tween.to);
        tween = null;
      }
    }

    updateProgress();
    const overRow = pointerOverRow();
    if (overRow !== drift.hover) {
      drift.hover = overRow;
      // Leaving the card row: clear the "paused after click" state and snap to the nearest card
      if (!overRow) {
        drift.pause = false;
        carTarget = wrapIndex(Math.round(carIndex));
      }
    }
    // Pause must not stick: after clicking a card/dot, as long as the pointer stayed inside the
    // row the old logic never cleared the pause ✗ → it looked like "looping is broken".
    // Here it auto-resumes after 9s (the carousel continues once the user stops interacting).
    if (drift.pause && !drift.wasPaused) drift.pausedAt = time;
    drift.wasPaused = drift.pause;
    if (drift.pause && time - drift.pausedAt > AUTO.resumePauseAfterMs) {
      drift.pause = false;
      carTarget = wrapIndex(Math.round(carIndex));
    }
    const canDrift = panelProgress > 0.85 && !reducedMotion.matches && !drift.pause &&
      (AUTO.always || (AUTO.onHover && drift.hover));
    if (canDrift) {
      // Loop: always forward, wrapping from the last card to the first
      drift.direction = 1;
      carIndex = wrapIndex(carIndex + dt / AUTO.secondsPerCard);
      carTarget = carIndex;
    }
    if (pointer.id === -1) carIndex = wrapIndex(carIndex + loopOffset(carTarget, carIndex) * (1 - Math.exp(-dt * 9)));
    if (Math.abs(loopOffset(carTarget, carIndex)) < 0.0005) carIndex = wrapIndex(carTarget);
    draw();

    frameWork = performance.now() - start;
    worstFrame = Math.max(worstFrame, frameWork);
    frameCount++;
    if (time - fpsWindowStart >= 1000) {
      fpsValue = frameCount * 1000 / (time - fpsWindowStart);
      frameCount = 0;
      fpsWindowStart = time;
    }
    if (debug && showDebug && time - debugUpdateTime >= 120) {
      debugUpdateTime = time;
      debug.textContent = `fps ${fpsValue.toFixed(0)}   frame ${frameWork.toFixed(2)}ms\nworst ${worstFrame.toFixed(2)}ms   morph ${progress.toFixed(3)}\npanel ${panelProgress.toFixed(3)}   card ${Math.round(carIndex) + 1}/4`;
    }

    const settling = Math.abs(loopOffset(carTarget, carIndex)) > 0.0005;
    // Must run every frame inside the morph range. If it were woken by scroll events only, a
    // coalesced/delayed event would leave the cards several frames behind native scroll
    // (measured up to 6 frames frozen then a jump) -- the main reason it "did not feel smooth".
    const inMorphRange = progress > 0 && progress < 1;
    if (tween || canDrift || settling || showDebug || inMorphRange) requestFrame();
    else lastFrameTime = 0;
  }

  function setTarget(index: number): void {
    drift.pause = true;
    carTarget = wrapIndex(index);
    requestFrame();
  }

  controls.addEventListener('pointerenter', () => {
    drift.hover = false;
    drift.pause = true;
    carTarget = wrapIndex(Math.round(carIndex));
    requestFrame();
  });
  controls.addEventListener('pointerleave', () => {
    drift.pause = false;
    carTarget = wrapIndex(Math.round(carIndex));
    requestFrame();
  });

  controls.querySelector<HTMLButtonElement>('[data-carousel-previous]')?.addEventListener('click', () => setTarget(Math.round(carTarget) - 1));
  controls.querySelector<HTMLButtonElement>('[data-carousel-next]')?.addEventListener('click', () => setTarget(Math.round(carTarget) + 1));
  dots.forEach((dot) => dot.addEventListener('click', () => setTarget(Number(dot.dataset.carouselDot))));
  document.querySelector<HTMLButtonElement>('[data-return-top]')?.addEventListener('click', () => scrollToY(0));

  // A click on the badge front = flip (motto on screen one / cover back on screen two).
  // Cannot rely on plane's pointerup alone: the carousel's pointer threshold does not hold on
  // the first screen, so it would return early.
  badge.addEventListener('click', (event) => {
    if ((event.target as HTMLElement | null)?.closest('a')) return; // back CTA is a link, skip
    // After a long press / drag the browser still fires click -- that must not flip (only a
    // short press flips)
    if (badge.dataset.wasDrag === '1') return;
    event.preventDefault();
    toggleFlip(0);
  });
  badge.addEventListener('focusin', () => setFlip(0));
  badge.addEventListener('focusout', () => {
    if (flipIndex === 0) setFlip(null);
  });
  badge.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleFlip(0);
  });

  plane.addEventListener('pointerdown', (event) => {
    if (panelProgress < 0.85 || event.button !== 0) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-morph-card]');
    if (!target) return;
    // Back CTA: do not setPointerCapture, otherwise the click is captured by the card and the
    // link never fires
    if ((event.target as HTMLElement).closest('.card-face--back a[href]')) return;
    pointer.id = event.pointerId;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.lastX = event.clientX;
    pointer.moved = 0;
    pointer.axis = null;
    pointer.index = Number(target.dataset.chapterIndex);
    pointer.startIndex = carIndex;
    pointer.velocity = 0;
    target.setPointerCapture(event.pointerId);
  });
  plane.addEventListener('pointermove', (event) => {
    if (pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.moved = Math.max(pointer.moved, Math.hypot(dx, dy));
    if (!pointer.axis && pointer.moved >= 6) pointer.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (pointer.axis !== 'x') return;
    event.preventDefault();
    drift.pause = true;
    pointer.velocity = event.clientX - pointer.lastX;
    pointer.lastX = event.clientX;
    carIndex = wrapIndex(pointer.startIndex - dx / (coverSpacing() * rowScale));
    carTarget = carIndex;
    requestFrame();
  });
  const finishPointer = (event: PointerEvent) => {
    if (pointer.id !== event.pointerId) return;
    const activeIndex = pointer.index;
    const wasClick = pointer.axis === null && pointer.moved < 6;
    if (pointer.axis === 'x') {
      const spacing = coverSpacing() * rowScale;
      const inertia = clamp(-pointer.velocity / spacing * 0.55, -0.7, 0.7);
      carTarget = wrapIndex(Math.round(carIndex + inertia));
      drift.pause = true;
    } else if (wasClick) {
      const onLink = Boolean((event.target as HTMLElement | null)?.closest('a'));
      // A click landing on a link is left to the click handler below (front flips/snaps, back
      // CTA navigates)
      if (!onLink) toggleFlip(activeIndex);
    }
    pointer.id = -1;
    pointer.axis = null;
    carTarget = wrapIndex(Math.round(carTarget));
    requestFrame();
  };
  plane.addEventListener('pointerup', finishPointer);
  plane.addEventListener('pointercancel', finishPointer);

  // Front links: intercept to flip (centred card) or snap to centre (side card) --
  // so "just wanting a quick look at the description" does not carry you away; the back CTA
  // is not intercepted and navigates normally.
  plane.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[data-card-link]');
    if (!link || !canInteract()) return;
    event.preventDefault();
    const cardElement = link.closest<HTMLElement>('[data-morph-card]');
    toggleFlip(cardElement ? Number(cardElement.dataset.chapterIndex) : 0);
  });

  plane.addEventListener('wheel', (event) => {
    if (panelProgress < 0.85 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    setTarget(Math.round(carTarget) + (event.deltaX > 0 ? 1 : -1));
  }, { passive: false });

  document.addEventListener('keydown', (event) => {
    if (panelProgress < 0.85 || !controls.contains(document.activeElement)) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setTarget(Math.round(carTarget) + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });

  function onScroll(): void { requestFrame(); }
  function onResize(): void { measureCards(); measureRowFit(); requestFrame(); }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
    } else requestFrame();
  });
  reducedMotion.addEventListener('change', requestFrame);

  const controller: LanyardMorphController = {
    update(nextSnapshot) {
      snapshot = nextSnapshot;
      draw();
      if (showDebug) requestFrame();
    },
    getProgress: () => progress,
    setBadgeFaceHandler(handler) { badgeFaceHandler = handler; },
    setPhysicsResumeHandler(handler) { physicsResumeHandler = handler; },
    getDebugState: () => Object.freeze({
      morphP: progress,
      panelP: panelProgress,
      carIndex,
      carTarget,
      drift: Object.freeze({ active: drift.hover && !drift.pause, paused: drift.pause, direction: drift.direction }),
      cards: Object.freeze(cards.map((card) => {
        const rect = card.element.getBoundingClientRect();
        return Object.freeze({
          index: card.index,
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
          opacity: Number(getComputedStyle(card.element).opacity),
          zIndex: card.element.style.zIndex,
        });
      })),
      fps: fpsValue,
      frame: frameWork,
      worst: worstFrame,
    }),
  };

  return controller;
}
