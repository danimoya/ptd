import type { LucideIcon } from "lucide-react";
import {
  Coffee,
  UtensilsCrossed,
  Dumbbell,
  Car,
  Footprints,
  Phone,
  BookOpen,
  BedDouble,
  Gamepad2,
  ShoppingBag,
  Sun,
  Cigarette,
  MapPin,
  Brain,
  Bike,
  Sparkles,
  Heart,
  Baby,
} from "lucide-react";

/**
 * Whitelist of icon names the server stores verbatim in `entry_templates.icon`.
 * Any unknown value falls back to the Coffee glyph.
 */
export const BREAK_ICONS: Record<string, LucideIcon> = {
  coffee: Coffee,
  lunch: UtensilsCrossed,
  meal: UtensilsCrossed,
  gym: Dumbbell,
  commute: Car,
  walk: Footprints,
  bike: Bike,
  call: Phone,
  read: BookOpen,
  rest: BedDouble,
  game: Gamepad2,
  errand: ShoppingBag,
  outside: Sun,
  smoke: Cigarette,
  travel: MapPin,
  think: Brain,
  partner: Heart,
  kids: Baby,
  other: Sparkles,
};

export const BREAK_ICON_NAMES = Object.keys(BREAK_ICONS);

// Common aliases a user or API caller might send.
const ALIASES: Record<string, string> = {
  car: "commute",
  commuting: "commute",
  food: "lunch",
  eat: "lunch",
  dinner: "lunch",
  workout: "gym",
  fitness: "gym",
  phone: "call",
  shopping: "errand",
  sleep: "rest",
  nap: "rest",
  book: "read",
  cycling: "bike",
  cigar: "smoke",
  think: "think",
};

export function iconFor(name: string | null | undefined): LucideIcon {
  if (!name) return Coffee;
  const k = name.toLowerCase();
  return BREAK_ICONS[k] ?? BREAK_ICONS[ALIASES[k]] ?? Coffee;
}

/** The small default set of quick-break tiles shown before the user adds their own. */
export interface BuiltInBreak {
  icon: string;
  name: string;
  note: string;
}
export const BUILTIN_BREAKS: BuiltInBreak[] = [
  { icon: "coffee", name: "Coffee", note: "Coffee break" },
  { icon: "lunch", name: "Lunch", note: "Lunch" },
  { icon: "gym", name: "Gym", note: "Gym" },
  { icon: "commute", name: "Commute", note: "Commuting" },
  { icon: "walk", name: "Walk", note: "Walk" },
  { icon: "call", name: "Call", note: "Phone call" },
  { icon: "partner", name: "Partner", note: "Partner" },
  { icon: "kids", name: "Kids", note: "Kids" },
  { icon: "errand", name: "Errand", note: "Errand" },
  { icon: "rest", name: "Rest", note: "Rest" },
];
