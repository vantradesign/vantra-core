/**
 * Truncates text to a maximum number of lines.
 */
export function clampLines(value: string, maxLines: number): string {
  return value.split('\n').slice(0, maxLines).join('\n')
}
