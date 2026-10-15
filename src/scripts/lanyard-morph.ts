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

// 卡片入场参数按实际卡片数量生成（数量 = DOM 里的静态卡 + 1 张吊牌封面）。
// 加减卡片只改 src/data/cards.ts，这里不需要手写 7 组数字。
type CardParams = { enter: [number, number]; arc: number };
// 轮播的「幻灯片」不含封面（第 0 张吊牌）：封面只负责飞出去并淡出。
// 幻灯片 s ↔ DOM 的 data-chapter-index = s + 1
let slideCount = 1;
let cardParams: CardParams[] = [{ enter: [0.02, 0.66], arc: -52 }];

function buildCardParams(count: number): CardParams[] {
  return Array.from({ length: count }, (_, i) => ({
    enter: [Math.min(0.02 + i * 0.045, 0.34), Math.min(0.62 + i * 0.05, 0.94)] as [number, number],
    arc: clamp(-52 + i * 20, -70, 70),
  }));
}

const COVER = {
  // 左舞台 + 右面板：当前卡的横向锚点（视口宽度的比例），右侧 360px 让给信息面板
  anchorRatio: 0.32,
  spacing: 238,
  // 间距 = 卡片实际宽度 × 这个比例。本站卡片是 clamp(244px, 21vw, 292px)，
  // 写死间距在宽屏下会小于卡片宽度（相邻卡叠在一起），换断点又不一致。
  spacingRatio: 1.12,
  // 深度调小：z 越大，透视把后排卡片往灭点收得越多（170 时整排差 7px，看起来歪）
  depth: 60,
  // 不倾斜：卡片一律竖直（之前 rotate 1.6 让左右两张歪着）
  rotate: 0,
  scaleStep: 0.085,
  // 只让当前卡 + 左右各 1 张清晰可见，第 2 张淡到几乎不可见（否则会伸到右侧面板底下）
  fadeStep: 0.95,
  // 不竖向错位、也不给当前卡"抬近"（liftZ 会让它在透视下被推下去，整排差 9px）
  yStep: 0,
  liftZ: 0,
  overshoot: 0.05,
};

// 面板文字会跟着切卡变化，漂移放慢到 7s/张（原来 2.8s 会太吵）
const AUTO = { onHover: true, always: false, secondsPerCard: 7, resumePauseAfterMs: 9000 } as const;

// 卡片组的自适应缩放与竖向中心：由 measureRowFit() 写入。
// 可用高度 = 章节标题底 → 控制条顶之间的那一段；卡片高 441px 时竖向塞不下，
// 不缩放就会同时压住标题和被控制条压住。
// 形变范围（第二屏归位所需的滚动距离），在 measureRowFit 里量；必须声明在模块作用域
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

// 循环轮播：索引与位姿都按"最短环绕距离"算，最后一张之后回到第一张
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
  // 封面（吊牌）不再走这里 —— 它在 draw() 里单独淡出。
  // 所以所有幻灯片都从「藏在吊牌后面」的位姿起飞：opacity 0、略偏、略微缩小。
  // 这里用 index + 1，是为了和原来 data-chapter-index 的偏移保持一致。
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

      // 内容卡不再翻面：说明与跳转入口已经在右侧面板里常驻显示（少一整套状态）
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

  // 卡片尺寸只在 measure 时量一次：draw() 每帧读 offsetWidth/offsetHeight 会白花计算
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
    // 控件已经搬进右侧面板，基准改成"标题底 → 版心底部"（留 64px 呼吸位）
    const narrow = window.innerWidth <= 760;
    const top = header ? header.offsetTop + header.offsetHeight + 10 : 0;
    const bottom = chapterStage.clientHeight - 64;
    const band = Math.max(220, bottom - top);
    rowScale = clamp((band - 28) / cardHeight, 0.5, 1);
    rowCenterY = top + band / 2;
    // 暴露给 CSS：面板据此与卡片行垂直对齐（否则一个居中在 50%、一个在 58% 看着不齐）
    chapterStage.style.setProperty('--row-center', `${Math.round(rowCenterY)}px`);
    // 形变范围：第二屏顶部滚到视口顶所需的距离（用绝对位置，避免 offsetParent 差异）
    morphRange = Math.round(chapterStage.getBoundingClientRect().top + window.scrollY);
    if (morphRange < 200) morphRange = Math.round(window.innerHeight + runway.offsetHeight);
    if (narrow) {
      // 窄屏：面板固定在底部，卡片整体上移并略缩，保证不和面板重叠
      rowScale = Math.min(rowScale, 0.92);
      rowCenterY = chapterStage.clientHeight * 0.36;
    }
  }

  measureRowFit();

  // 相邻卡片的水平间距：跟着卡片实际宽度走，任何断点下都一致
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
  // 翻面状态：只有 carIndex 附近的那张允许翻开；离开中心即复位
  let flipIndex: number | null = null;
  let pendingFlip: number | null = null;
  let physicsResumeHandler = () => {};
  // 开扣：滚屏一开始，钩绕环心转出去（转场的第一拍）
  const rigHook = scene?.querySelector<SVGGElement>('[data-rig-hook]');
  const ribbonCanvas = scene?.querySelector<HTMLCanvasElement>('[data-strap-ribbon3d]');
  let currentLabel = '';
  // 右侧信息面板：字段从卡片 DOM 的 data-* 读（单一数据源 = src/data/cards.ts）
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
    // 交叉淡入：先淡出再换文字（只在切换时动 DOM，不做逐帧写）
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

  // 形变范围 = 第二屏刚好滚到视口顶部所需的滚动距离。
  // 之前用 runway 高度（80vh），于是卡片在 590px 处就落位，而第二屏要 1328px 才归位 ——
  // 中间 738px 里标题会从固定层的卡片上扫过去（刷新停在那儿就是"图片和标题重合"）。
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
    // 淡入窗口按剩余可滚距离收窄，并在触底时直接给到 1 ——
    // 否则面板/水印会停在 0.988 这种"差一点"的值上。
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    // 面板淡入收在最后一段（卡片基本落位之后），避免和飞行中的卡片交叉
    const panelWindow = clamp(length * 0.16, 140, 260);
    // 淡入窗口要提前一个 panelWindow 开始，否则会到最后一帧才跳出来
    panelProgress = window.scrollY >= maxScroll - 2 ? 1 : clamp((window.scrollY - (length - panelWindow)) / panelWindow, 0, 1);
    const panelOpacity = easeInOutCubic(panelProgress);
    const root = document.documentElement;
    root.style.setProperty('--morph-chrome', String(1 - easeInOutCubic(span(progress, [0, 0.3]))));
    root.style.setProperty('--morph-panel', panelOpacity.toFixed(3));
    root.style.setProperty('--morph-next', (easeInOutCubic(span(progress, [0.1, 0.5])) * (1 - panelOpacity)).toFixed(3));
    // 身份内容先淡出、章节内容后淡入，两段不重叠 —— 否则中途会同时看到
    // 半透明的人脸/名字和章节列表叠在一张卡上（"重影"）。
    // 第 0 张现在是 About Me 封面（正面身份始终可见），不再需要"身份 → 章节"交叉淡入
    plane.classList.toggle('morph-plane--carousel', panelProgress > 0.85);
    scene.classList.toggle('is-morph-locked', progress > 0.04);
    if (previousProgress > 0.04 && progress <= 0.04) physicsResumeHandler();
    // 一开滚就把吊牌翻回正面：否则它会在过渡段带着背面（座右铭）飞，和 HELLO. 同屏重复。
    // 用"0 → >0"的跨越判断，直接跳到底部（一帧跨完）也能复位。
    if (previousProgress <= 0.001 && progress > 0.001 && flipIndex === 0) setFlip(null);
  }

  // 卡片会在指针下面滑走，用 pointerover/pointerout 判断悬停会误判成"离开"，
  // 于是漂移走一张就停。这里改成按几何区域判断：指针是否落在卡片行的范围内。
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

  // 轮播要等面板起来才可交互（和现有的拖拽门槛一致）
  function canInteract(): boolean {
    return panelProgress >= 0.85;
  }

  function setFlip(next: number | null): void {
    // 内容卡传的是 data-chapter-index（≥1），幻灯片 = index - 1；封面只在第一屏有效
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
    // 吊牌（第 0 张）第一屏、第二屏都能翻：第一屏看座右铭，第二屏看封面背面 + More about me
    if (index === 0) {
      // 封面（吊牌）只在第一屏可翻；第二屏它已经淡出
      if (progress > 0.5) return;
      setFlip(flipIndex === 0 ? null : 0);
      return;
    }
    if (!canInteract()) return;
    // 内容卡：点击 = 吸附到中间（不再翻面，说明与链接在右侧面板）
    setTarget(index - 1);
  }

  function draw(): void {
    if (!snapshot) return;
    updateProgress();
    // 离开中心就复位，避免"翻着的卡在队伍里游荡"（封面只在第一屏有效）
    const flipValid = flipIndex === null || (flipIndex === 0 ? progress <= 0.5 : isCentered(flipIndex - 1));
    if (flipIndex !== null && !flipValid) setFlip(null);
    if (pendingFlip !== null && Math.round(carIndex) === pendingFlip) {
      const index = pendingFlip;
      pendingFlip = null;
      setFlip(index);
    }
    const { width, height } = snapshot;
    // 舞台锚点：当前卡的横向基准（原来是视口中心，现在左移给右侧面板让位）
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
    // 开扣：0.008 → 0.10 之间把钩转出 42° 并上抬 7px（滚一点点就完成，读起来是"我先解开"）
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
        // 结尾带上 --strap-twist：翻面时吊绳跟着翻转的那点扭转（由 lanyard-pass 算）
        element.style.transform = `translateY(${-strapProgress * height * 0.62}px) rotate(var(--strap-twist, 0deg))`;
      }
    }

    for (const card of cards) {
      const size = cardSizes.get(card.index);
      const cardWidth = size ? size.width : card.element.offsetWidth;
      const cardHeight = size ? size.height : card.element.offsetHeight;

      // 封面（第 0 张吊牌）：不参与轮播，飞出去的同时淡出
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
      // 幻灯片 s ↔ data-chapter-index = s + 1（封面不在轮播里）
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
      // 离开卡片行：解除"点击后暂停"，并吸附到最近一张
      if (!overRow) {
        drift.pause = false;
        carTarget = wrapIndex(Math.round(carIndex));
      }
    }
    // 暂停不能"粘住"：点过卡片/圆点后，只要鼠标还留在卡片行里，
    // 原来的逻辑就永远不会解除暂停 ✗ → 表现为"不能循环播放"。
    // 这里让它 9 秒后自动恢复（用户停止交互就继续轮播）。
    if (drift.pause && !drift.wasPaused) drift.pausedAt = time;
    drift.wasPaused = drift.pause;
    if (drift.pause && time - drift.pausedAt > AUTO.resumePauseAfterMs) {
      drift.pause = false;
      carTarget = wrapIndex(Math.round(carIndex));
    }
    const canDrift = panelProgress > 0.85 && !reducedMotion.matches && !drift.pause &&
      (AUTO.always || (AUTO.onHover && drift.hover));
    if (canDrift) {
      // 循环：一直向前，最后一张之后接第一张
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
    // 形变区间内必须每帧都跑。靠 scroll 事件唤醒的话，事件被合并/延迟时卡片就会落后
    // 原生滚动好几帧（实测最多 6 帧不动再跳），这是"不丝滑"的主因。
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

  // 吊牌正面的点击 = 翻面（第一屏看座右铭 / 第二屏看封面背面）。
  // 不能只靠 plane 的 pointerup：轮播的指针门槛在第一屏不成立，会被提前 return 掉。
  badge.addEventListener('click', (event) => {
    if ((event.target as HTMLElement | null)?.closest('a')) return; // 背面 CTA 是链接，不拦
    // 长按 / 拖拽之后浏览器仍会派发 click —— 这种不翻面（短按才翻）
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
    // 背面 CTA：不要 setPointerCapture，否则 click 会被捕获到卡片上，链接永远不触发
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
      // 落在链接上的点击交给下面的 click 处理器（正面翻面/吸附，背面 CTA 直接跳转）
      if (!onLink) toggleFlip(activeIndex);
    }
    pointer.id = -1;
    pointer.axis = null;
    carTarget = wrapIndex(Math.round(carTarget));
    requestFrame();
  };
  plane.addEventListener('pointerup', finishPointer);
  plane.addEventListener('pointercancel', finishPointer);

  // 正面链接：拦下来翻面（居中的卡）或吸附到中间（侧卡）——
  // 避免"只想看一眼介绍就被带走"；背面 CTA 不拦截，正常跳转。
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
