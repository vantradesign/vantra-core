import type { TokenCategory } from '../types'
import { splitTokenPath } from '../internal/paths'

/**
 * Maps declared token types (DTCG `$type`, Style Dictionary `type`) onto
 * normalized categories.
 */
const DECLARED_TYPE_CATEGORIES: Record<string, TokenCategory> = {
  color: 'color',
  colour: 'color',
  dimension: 'spacing',
  spacing: 'spacing',
  space: 'spacing',
  size: 'sizing',
  sizing: 'sizing',
  fontfamily: 'typography',
  fontweight: 'typography',
  fontsize: 'typography',
  lineheight: 'typography',
  letterspacing: 'typography',
  typography: 'typography',
  font: 'typography',
  text: 'typography',
  border: 'border',
  borderwidth: 'border',
  borderradius: 'radius',
  radius: 'radius',
  shadow: 'shadow',
  boxshadow: 'shadow',
  elevation: 'shadow',
  opacity: 'opacity',
  duration: 'motion',
  cubicbezier: 'motion',
  transition: 'motion',
  motion: 'motion',
  animation: 'motion',
  zindex: 'z-index',
  breakpoint: 'breakpoint',
  asset: 'asset',
  file: 'asset',
  number: 'other',
  string: 'other',
  other: 'other',
}

/**
 * Declared types that carry no semantic information about a token's role.
 */
const GENERIC_DECLARED_TYPES = new Set(['number', 'string', 'boolean', 'other'])

/**
 * Keyword patterns matched against a token's path segments, in priority order.
 *
 * Order matters: `borderRadius` must resolve to `radius`, not `border`, so the
 * more specific patterns are listed first.
 */
const PATH_CATEGORY_RULES: ReadonlyArray<readonly [RegExp, TokenCategory]> = [
  [/^(?:radius|radii|rounded|corner)$/, 'radius'],
  [/^(?:borderradius|cornerradius)$/, 'radius'],
  [/^(?:shadow|shadows|elevation|boxshadow)$/, 'shadow'],
  [/^(?:color|colors|colour|colours|palette|fill|stroke|background|foreground|text-?color)$/, 'color'],
  [/^(?:space|spacing|gap|inset|margin|padding)$/, 'spacing'],
  [/^(?:size|sizes|sizing|width|height|dimension|dimensions)$/, 'sizing'],
  [
    /^(?:font|fonts|typography|type|text|letter-?spacing|line-?height|font-?size|font-?family|font-?weight)$/,
    'typography',
  ],
  [/^(?:border|borders|outline|divider)$/, 'border'],
  [/^(?:opacity|alpha|transparency)$/, 'opacity'],
  [/^(?:duration|easing|transition|motion|animation|delay)$/, 'motion'],
  [/^(?:z|zindex|z-?index|layer|layers)$/, 'z-index'],
  [/^(?:breakpoint|breakpoints|screen|screens|media)$/, 'breakpoint'],
  [/^(?:asset|assets|icon|icons|image|images)$/, 'asset'],
]

/**
 * Normalizes a token path into its canonical dot-delimited name.
 *
 * Segments are lower-cased and camelCase is split, so that the JSON path
 * `["color", "brandPrimary"]` and the CSS variable `--color-brand-primary`
 * both normalize to `color.brand.primary`. This is the single rule that makes
 * cross-format token comparison possible.
 *
 * @internal
 */
export function normalizeTokenName(segments: readonly string[]): string {
  return segments
    .flatMap((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s._\-/]+/),
    )
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment !== '')
    .join('.')
}

/**
 * Converts a canonical token name into its CSS custom property form.
 *
 * @internal
 */
export function toCssVariable(canonicalName: string, prefix?: string): string {
  const body = canonicalName.split('.').join('-')
  const normalizedPrefix = prefix === undefined || prefix === '' ? '' : `${stripDashes(prefix)}-`
  return `--${normalizedPrefix}${body}`
}

/**
 * Converts a CSS custom property into canonical path segments, dropping the
 * configured prefix.
 *
 * @internal
 */
export function cssVariableToSegments(cssVariable: string, prefix?: string): string[] {
  let body = cssVariable.replace(/^--/, '')

  if (prefix !== undefined && prefix !== '') {
    const normalizedPrefix = stripDashes(prefix)
    if (body === normalizedPrefix) return []
    if (body.startsWith(`${normalizedPrefix}-`)) {
      body = body.slice(normalizedPrefix.length + 1)
    }
  }

  return splitTokenPath(body)
}

/**
 * Removes leading and trailing dashes from a configured prefix.
 */
function stripDashes(value: string): string {
  return value.replace(/^-+|-+$/g, '')
}

/**
 * Determines a token's semantic category.
 *
 * An explicitly declared type always wins; otherwise the path segments are
 * matched against keyword rules, most specific segment first.
 *
 * @internal
 */
export function inferCategory(
  segments: readonly string[],
  declaredType: string | undefined,
): TokenCategory {
  if (declaredType !== undefined) {
    const key = declaredType.replace(/[\s._-]/g, '').toLowerCase()

    // `number` / `string` describe the value's shape, not its design role, so
    // they must not stop the far more informative path-based inference.
    if (!GENERIC_DECLARED_TYPES.has(key)) {
      const mapped = DECLARED_TYPE_CATEGORIES[key]
      if (mapped !== undefined) return mapped
    }
  }

  const normalized = segments.map((segment) => segment.toLowerCase())

  // A joined form catches multi-segment names like ['border', 'radius'].
  const joined = normalized.join('')
  for (const [pattern, category] of PATH_CATEGORY_RULES) {
    if (pattern.test(joined)) return category
  }

  for (const segment of normalized) {
    for (const [pattern, category] of PATH_CATEGORY_RULES) {
      if (pattern.test(segment)) return category
    }
  }

  return 'other'
}

/**
 * Matches a DTCG alias reference: `{color.base.blue.500}`.
 *
 * The character class is deliberately narrow. A composite token value (a
 * typography set or shadow list) is stored as serialized JSON, which is also
 * wrapped in braces — a permissive pattern would misread the whole object as
 * one enormous alias name.
 */
const DTCG_ALIAS_PATTERN = /\{([A-Za-z0-9_. -]+)\}/g

/**
 * Matches a CSS alias reference: `var(--color-base-blue-500)`.
 */
const CSS_ALIAS_PATTERN = /var\(\s*(--[A-Za-z0-9_-]+)/g

/**
 * Both alias syntaxes, for extraction.
 */
const ALIAS_PATTERNS: readonly RegExp[] = [DTCG_ALIAS_PATTERN, CSS_ALIAS_PATTERN]

/**
 * Extracts the canonical names of every token referenced by a value.
 *
 * @internal
 */
export function extractAliases(value: string, cssVariablePrefix?: string): string[] {
  const aliases = new Set<string>()

  for (const pattern of ALIAS_PATTERNS) {
    for (const match of value.matchAll(pattern)) {
      const captured = match[1]
      if (captured === undefined) continue

      const segments = captured.startsWith('--')
        ? cssVariableToSegments(captured, cssVariablePrefix)
        : splitTokenPath(captured)

      const canonical = normalizeTokenName(segments)
      if (canonical !== '') aliases.add(canonical)
    }
  }

  return [...aliases].sort()
}

/**
 * Rewrites a raw value by substituting every resolvable alias.
 *
 * @param rawValue - The value as authored.
 * @param resolve - Looks up the concrete value of a canonical token name.
 * @returns The substituted value, or the original when nothing could be resolved.
 *
 * @internal
 */
export function substituteAliases(
  rawValue: string,
  cssVariablePrefix: string | undefined,
  resolve: (canonicalName: string) => string | undefined,
): string {
  let result = rawValue

  result = result.replace(DTCG_ALIAS_PATTERN, (original, captured: string) => {
    const replacement = resolve(normalizeTokenName(splitTokenPath(captured)))
    return replacement ?? original
  })

  result = result.replace(
    /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)/g,
    (original, captured: string, fallback: string | undefined) => {
      const canonical = normalizeTokenName(cssVariableToSegments(captured, cssVariablePrefix))
      return resolve(canonical) ?? fallback?.trim() ?? original
    },
  )

  return result
}
