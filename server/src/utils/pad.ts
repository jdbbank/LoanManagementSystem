/** Pads a number with leading zeros to the given width. */
export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
