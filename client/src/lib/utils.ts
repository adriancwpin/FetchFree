import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// A small select or input matching the theme's input styling, for controls inside a card.
// Dropdown options get an explicit background: a transparent <select> otherwise shows its options
// with the theme's light text on the browser's white popup.
export const COMPACT_FIELD_CLASS =
  'h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 [&_option]:bg-popover [&_option]:text-popover-foreground'
