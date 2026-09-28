import { notImplemented } from '../todo';

/** Minimal event shape needed to describe it (a stored row, possibly redacted). */
export interface DescribableEvent {
  type: string;
  valueGp: number | null;
  skill: string | null;
  level: number | null;
  tier: string | null;
  points: number | null;
  /** The stored original event: {type, data, eventId, timestamp}. */
  data: unknown;
}

export interface EventDescription {
  /** Short title, e.g. "Loot", "Level up", "Death". */
  title: string;
  /**
   * One line for toasts and feeds, starting with the account name, e.g.
   * "Zezima received Dragon warhammer (38.2M) from Lizardman shaman",
   * "Zezima reached level 85 Strength", "Zezima died (inventory value lost: 34.9K)",
   * "Zezima completed a Grandmaster combat task: No Pressure (6 points)",
   * "Zezima completed an Easy Varrock diary task", "Zezima: new collection log item Tanzanite fang",
   * "A superior Nechryarch spawned for Zezima", unknown types: "Zezima: questComplete".
   */
  line: string;
  /** lucide-react icon name hint: 'gift' | 'skull' | 'trending-up' | 'book' | 'swords' | 'map' | 'sparkles' | 'bell'. */
  icon: string;
}

/** Human-readable description of a stored event. Never throws on odd data. */
export function describeEvent(accountName: string, event: DescribableEvent): EventDescription {
  return notImplemented('describeEvent');
}
