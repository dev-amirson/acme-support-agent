import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Class joiner with Tailwind conflict resolution (shadcn / Proof8 convention). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
