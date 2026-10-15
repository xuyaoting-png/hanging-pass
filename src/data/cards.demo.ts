/**
 * Demo data — swap in your own content.
 *
 * Structure:
 *   · index 0 + tier 'cover' is the badge (the screen-1 card); its content is written
 *     straight in index.astro; the cover entry here only supplies index/label fields.
 *   · The remaining entries are the cards in the screen-2 carousel.
 *   · front.image empty → title-only face (clean, works with no image); add a path to
 *     fill the card. href points at your detail page; the demo uses '#' to avoid 404s.
 */

export type SiteCard = {
  /** Matches data-chapter-index in the DOM; 0 = cover (the badge) */
  index: number;
  id: string;
  label: string;
  /** Small label at the top left of the front face */
  kicker: string;
  /** Short tag at the top right of the front face */
  tag: string;
  href: string;
  /** Accent colour (for small highlight touches) */
  accent: string;
  tier: 'cover' | 'business' | 'personal';
  /** Cards whose content is not ready yet are not rendered */
  draft?: boolean;
  front: {
    /** Front hero image; empty means title only */
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
