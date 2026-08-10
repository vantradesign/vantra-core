import postcss, { type AtRule, type Rule } from 'postcss'
import type { TokenParseWarning, TokenSourceFormat } from '../types'

/**
 * One token definition as read from a file, before normalization.
 *
 * @internal
 */
export interface RawToken {
  /** Path segments exactly as authored. */
  segments: string[]
  /** The authored name (JSON key path joined by `.`, or the CSS custom property). */
  originalName: string
  /** The authored value, stringified. */
  rawValue: string
  /** Explicit `$type` / `type`, when declared. */
  declaredType?: string
  /** Author-provided description. */
  description?: string
  /** Which format this came from. */
  format: TokenSourceFormat
  /** Repository-relative path of the defining file. */
  filePath: string
  /** CSS selector scope, when applicable. */
  scope?: string
}

/** Keys that mark an object as a token leaf rather than a group. */
const VALUE_KEYS = ['$value', 'value'] as const

/** Keys carrying an explicit type declaration. */
const TYPE_KEYS = ['$type', 'type'] as const

/** Keys carrying a human description. */
const DESCRIPTION_KEYS = ['$description', 'description', 'comment'] as const

/**
 * Unprefixed keys that are token metadata rather than child tokens.
 *
 * Without this, a descriptor that is missing its `value` (`{ "type": "color",
 * "comment": "…" }`) would be mistaken for a group and its own metadata would
 * be emitted as two bogus tokens.
 */
const METADATA_KEYS = new Set(['type', 'comment', 'description'])

/**
 * Reads a JSON token file in DTCG, Style Dictionary or plain-nested format.
 *
 * All three are handled by the same traversal: an object is a *leaf* when it
 * carries a `$value`/`value` key, and a *group* otherwise. Group-level `$type`
 * is inherited by descendants, as the DTCG spec requires.
 *
 * @internal
 */
export function readJsonTokens(
  content: string,
  filePath: string,
  warnings: TokenParseWarning[],
): RawToken[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    warnings.push({
      code: 'invalid-json',
      message: `Could not parse JSON: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    })
    return []
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warnings.push({
      code: 'invalid-json',
      message: 'Token file must contain a JSON object at its root.',
      filePath,
    })
    return []
  }

  const tokens: RawToken[] = []
  walkJson(parsed as Record<string, unknown>, [], undefined, filePath, tokens, warnings)
  return tokens
}

/**
 * Recursively walks a token tree.
 */
function walkJson(
  node: Record<string, unknown>,
  segments: string[],
  inheritedType: string | undefined,
  filePath: string,
  tokens: RawToken[],
  warnings: TokenParseWarning[],
): void {
  const declaredType = readStringKey(node, TYPE_KEYS) ?? inheritedType

  for (const [key, value] of Object.entries(node)) {
    // `$`-prefixed keys are group metadata, never child tokens.
    if (key.startsWith('$')) continue
    if (METADATA_KEYS.has(key) && typeof value === 'string') continue

    const childSegments = [...segments, key]

    if (isPlainObject(value)) {
      if (hasValueKey(value)) {
        const token = toLeafToken(value, childSegments, declaredType, filePath, warnings)
        if (token !== undefined) tokens.push(token)
        continue
      }

      // Metadata but no value and no children: an incomplete token, not a group.
      if (isIncompleteDescriptor(value)) {
        warnings.push({
          code: 'missing-value',
          message: `Token "${childSegments.join('.')}" declares metadata but no value.`,
          filePath,
          tokenName: childSegments.join('.'),
        })
        continue
      }

      walkJson(value, childSegments, declaredType, filePath, tokens, warnings)
      continue
    }

    // A bare scalar leaf: `{ "color": { "primary": "#f00" } }`.
    const stringified = stringifyValue(value)
    if (stringified === undefined) {
      warnings.push({
        code: 'unsupported-value',
        message: `Unsupported token value at "${childSegments.join('.')}".`,
        filePath,
        tokenName: childSegments.join('.'),
      })
      continue
    }

    const token: RawToken = {
      segments: childSegments,
      originalName: childSegments.join('.'),
      rawValue: stringified,
      format: 'json',
      filePath,
    }
    if (declaredType !== undefined) token.declaredType = declaredType

    tokens.push(token)
  }
}

/**
 * Builds a token from an object leaf carrying `$value` / `value`.
 */
function toLeafToken(
  node: Record<string, unknown>,
  segments: string[],
  inheritedType: string | undefined,
  filePath: string,
  warnings: TokenParseWarning[],
): RawToken | undefined {
  const name = segments.join('.')

  const rawValue = stringifyValue(readKey(node, VALUE_KEYS))
  if (rawValue === undefined) {
    warnings.push({
      code: 'missing-value',
      message: `Token "${name}" declares no usable value.`,
      filePath,
      tokenName: name,
    })
    return undefined
  }

  const token: RawToken = {
    segments,
    originalName: name,
    rawValue,
    format: 'json',
    filePath,
  }

  const declaredType = readStringKey(node, TYPE_KEYS) ?? inheritedType
  if (declaredType !== undefined) token.declaredType = declaredType

  const description = readStringKey(node, DESCRIPTION_KEYS)
  if (description !== undefined) token.description = description

  return token
}

/**
 * Reads CSS custom property declarations from a stylesheet.
 *
 * Every declaration is captured together with the selector it appears under, so
 * that `:root` base values and `[data-theme='dark']` overrides can later be
 * folded into one token with variants.
 *
 * @internal
 */
export function readCssTokens(
  content: string,
  filePath: string,
  warnings: TokenParseWarning[],
): RawToken[] {
  const tokens: RawToken[] = []

  let root: postcss.Root
  try {
    root = postcss.parse(content, { from: filePath })
  } catch (error) {
    warnings.push({
      code: 'invalid-css',
      message: `Could not parse CSS: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    })
    return tokens
  }

  root.walkDecls((declaration) => {
    if (!declaration.prop.startsWith('--')) return

    const value = declaration.value.trim()
    if (value === '') {
      warnings.push({
        code: 'missing-value',
        message: `Custom property "${declaration.prop}" has an empty value.`,
        filePath,
        tokenName: declaration.prop,
      })
      return
    }

    const token: RawToken = {
      // Segments are derived from the property name during normalization,
      // because the configured prefix must be stripped first.
      segments: [],
      originalName: declaration.prop,
      rawValue: value,
      format: 'css',
      filePath,
    }

    const scope = describeScope(declaration.parent)
    if (scope !== undefined) token.scope = scope

    const description = readCssDescription(declaration)
    if (description !== undefined) token.description = description

    tokens.push(token)
  })

  return tokens
}

/**
 * Builds a readable scope string from a declaration's ancestors, e.g.
 * `@media (prefers-color-scheme: dark) :root`.
 */
function describeScope(parent: postcss.Container | undefined): string | undefined {
  if (parent === undefined) return undefined

  const parts: string[] = []
  let current: postcss.Container | postcss.Document | undefined = parent

  while (current !== undefined) {
    if (current.type === 'rule') {
      parts.unshift((current as Rule).selector.replace(/\s+/g, ' ').trim())
    } else if (current.type === 'atrule') {
      const atRule = current as AtRule
      parts.unshift(`@${atRule.name} ${atRule.params}`.trim())
    }
    current = current.parent as postcss.Container | undefined
  }

  const scope = parts.join(' ').trim()
  return scope === '' ? undefined : scope
}

/**
 * Reads a `/* ... *\/` comment placed immediately before a declaration.
 */
function readCssDescription(declaration: postcss.Declaration): string | undefined {
  const previous = declaration.prev()
  if (previous === undefined || previous.type !== 'comment') return undefined

  const text = previous.text.trim()
  return text === '' ? undefined : text
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `true` for non-null, non-array objects.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `true` when an object is a token leaf.
 */
function hasValueKey(node: Record<string, unknown>): boolean {
  return VALUE_KEYS.some((key) => key in node)
}

/**
 * `true` for an object that carries token metadata but neither a value nor any
 * nested groups — i.e. an author forgot the value.
 */
function isIncompleteDescriptor(node: Record<string, unknown>): boolean {
  const entries = Object.entries(node)
  if (entries.length === 0) return false

  const hasMetadata = entries.some(
    ([key]) => key.startsWith('$') || METADATA_KEYS.has(key),
  )
  const hasChildGroups = entries.some(([, value]) => isPlainObject(value))

  return hasMetadata && !hasChildGroups
}

/**
 * Reads the first present key from a candidate list.
 */
function readKey(node: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in node) return node[key]
  }
  return undefined
}

/**
 * Reads the first present key that holds a non-empty string.
 */
function readStringKey(
  node: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  const value = readKey(node, keys)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Renders a JSON token value as a string.
 *
 * Composite values (typography sets, shadow arrays) are preserved as compact
 * JSON so that no information is lost, while the token contract stays a simple
 * string.
 */
function stringifyValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object') return JSON.stringify(value)
  return undefined
}
