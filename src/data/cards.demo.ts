/**
 * 演示数据 —— 换成你自己的内容即可。
 *
 * 结构说明：
 *   · index 0 + tier 'cover' 是吊牌（第一屏那张卡），它的内容在 index.astro 里直接写；
 *     这里的封面条目主要提供 index/标签等字段。
 *   · 其余条目是第二屏轮播里的卡片。
 *   · front.image 留空 → 卡面只有标题（干净、无图也能跑）；填上图片路径就会整卡铺满。
 *   · href 指向你的详情页；演示里统一用 '#'，避免出现 404。
 */

export type SiteCard = {
  /** 与 DOM 的 data-chapter-index 一致；0 = 封面（吊牌） */
  index: number;
  id: string;
  label: string;
  /** 正面上方左侧的小标签 */
  kicker: string;
  /** 正面上方右侧的短标签 */
  tag: string;
  href: string;
  /** 主题色（小面积点睛用） */
  accent: string;
  tier: 'cover' | 'business' | 'personal';
  /** 内容未就绪的卡先不渲染 */
  draft?: boolean;
  front: {
    /** 正面大图；留空则只有标题 */
    image?: string;
    alt: string;
  };
  back: {
    summary: string;
    bullets: string[];
    cta: string;
  };
};

export const DEMO_CARDS: SiteCard[] = [
  {
    index: 0,
    id: 'cover',
    label: 'Your Name',
    kicker: 'HELLO',
    tag: 'DEMO',
    href: '#',
    accent: '#26312b',
    tier: 'cover',
    front: { alt: 'Cover card' },
    back: { summary: 'Cover card.', bullets: [], cta: 'Start' },
  },
  {
    index: 1,
    id: 'work',
    label: 'Work',
    kicker: 'CHAPTER 01',
    tag: 'SELECTED',
    href: '#',
    accent: '#26312b',
    tier: 'business',
    front: { alt: 'Work' },
    back: {
      summary: 'What you do, in one or two lines. This is the back of the card — flip it to read.',
      bullets: ['Project one', 'Project two', 'Project three'],
      cta: 'See the work',
    },
  },
  {
    index: 2,
    id: 'process',
    label: 'Process',
    kicker: 'CHAPTER 02',
    tag: 'HOW',
    href: '#',
    accent: '#6f7d8c',
    tier: 'business',
    front: { alt: 'Process' },
    back: {
      summary: 'How the work gets made — the steps you follow, and why.',
      bullets: ['Research', 'Prototype', 'Ship', 'Iterate'],
      cta: 'Read the process',
    },
  },
  {
    index: 3,
    id: 'toolkit',
    label: 'Toolkit',
    kicker: 'CHAPTER 03',
    tag: 'STACK',
    href: '#',
    accent: '#c8613a',
    tier: 'personal',
    front: { alt: 'Toolkit' },
    back: {
      summary: 'The tools and references you keep coming back to.',
      bullets: ['Astro', 'TypeScript', 'Three.js', 'Figma'],
      cta: 'Open the toolkit',
    },
  },
  {
    index: 4,
    id: 'notes',
    label: 'Notes',
    kicker: 'CHAPTER 04',
    tag: 'WRITING',
    href: '#',
    accent: '#5b6ee1',
    tier: 'personal',
    front: { alt: 'Notes' },
    back: {
      summary: 'Short notes: things learned while building, kept for later.',
      bullets: ['On motion', 'On physics', 'On restraint'],
      cta: 'Read the notes',
    },
  },
  {
    index: 5,
    id: 'reading',
    label: 'Reading',
    kicker: 'CHAPTER 05',
    tag: 'LINKS',
    href: '#',
    accent: '#d0a13c',
    tier: 'personal',
    front: { alt: 'Reading' },
    back: {
      summary: 'A running list of what is worth reading right now.',
      bullets: ['Reference one', 'Reference two', 'Reference three'],
      cta: 'Browse the list',
    },
  },
  {
    index: 6,
    id: 'archive',
    label: 'Archive',
    kicker: 'CHAPTER 06',
    tag: 'COLLECTED',
    href: '#',
    accent: '#0a0a0a',
    tier: 'personal',
    front: { alt: 'Archive' },
    back: {
      summary: 'Older work and experiments, kept for the record.',
      bullets: ['Experiment one', 'Experiment two', 'Experiment three'],
      cta: 'Enter the archive',
    },
  },
];
