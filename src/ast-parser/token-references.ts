/**
 * Matches a CSS custom property used as a *reference*:
 *
 * - `var(--color-brand-primary)` — stylesheets, `<style>` blocks, inline styles
 * - `'--color-brand-primary'` — `style={{ '--x': v }}`, `el.style.setProperty('--x', v)`
 *
 * Declarations (`--x: value;`) are intentionally not matched here: those are
 * token *definitions* and belong to the token-schema module, not to a
 * component's dependency list.
 */
const TOKEN_REFERENCE_PATTERN = /(?:var\(\s*|["'`])(--[A-Za-z0-9_-]+)/g

/**
 * Extracts every design token referenced by a source file.
 *
 * Runs against the raw file text rather than the AST so that a single pass
 * covers a Vue SFC's `<template>`, `<script>` and `<style>` blocks alike.
 *
 * @param sourceText - Raw file contents.
 * @returns De-duplicated, sorted `--token-name` strings.
 *
 * @internal
 */
export function extractTokenReferences(sourceText: string): string[] {
  const found = new Set<string>()

  for (const match of sourceText.matchAll(TOKEN_REFERENCE_PATTERN)) {
    const name = match[1]
    if (name === undefined) continue

    // A trailing dash means the name was cut short by a template placeholder,
    // e.g. `var(--shadow-${level})`. The real token name is only known at
    // runtime, so recording the truncated prefix would be actively misleading.
    if (name.endsWith('-')) continue

    const next = sourceText[(match.index ?? 0) + match[0].length]
    if (next === '$' || next === '{') continue

    found.add(name)
  }

  return [...found].sort()
}
