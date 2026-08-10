import type {
  DesignToken,
  ParseTokenSchemaOptions,
  TokenCategory,
  TokenParseWarning,
  TokenSchema,
  TokenSourceFile,
  TokenVariant,
} from '../types'
import { extensionOf, toRepoRelative } from '../internal/paths'
import { assertReadableDirectory, readFileSafe, scanRepository } from '../internal/scan'
import {
  cssVariableToSegments,
  extractAliases,
  inferCategory,
  normalizeTokenName,
  substituteAliases,
  toCssVariable,
} from './normalize'
import { readCssTokens, readJsonTokens, type RawToken } from './readers'

/** Default glob patterns for token discovery. */
const DEFAULT_INCLUDE = [
  '**/*.tokens.json',
  '**/tokens.json',
  '**/tokens/**/*.json',
  '**/design-tokens/**/*.json',
  '**/*.css',
]

/** Default guard rail on the number of token files read. */
const DEFAULT_MAX_FILES = 2000

/** Every category, so `byCategory` is always fully populated. */
const ALL_CATEGORIES: readonly TokenCategory[] = [
  'color',
  'spacing',
  'sizing',
  'typography',
  'border',
  'radius',
  'shadow',
  'opacity',
  'motion',
  'z-index',
  'breakpoint',
  'asset',
  'other',
]

/** Scopes treated as the base (unthemed) definition of a token. */
const BASE_SCOPES = new Set([':root', 'html', ':host', ':where(:root)'])

/**
 * Parses every design-token file in a repository into one normalized schema.
 *
 * Both JSON (DTCG `$value`, Style Dictionary `value`, and plain nested objects)
 * and CSS custom properties are supported, and both normalize to the same
 * canonical dot-delimited names — so `{ color: { brandPrimary } }` in JSON and
 * `--color-brand-primary` in CSS are recognised as the same token.
 *
 * Malformed or partial token files never throw. Every problem is reported in
 * {@link TokenSchema.warnings}, so a single broken file cannot fail a pipeline
 * that governs an entire design system. A missing or unreadable `repoPath` does
 * throw, since that is a caller error.
 *
 * @param repoPath - Absolute or relative path to the repository root.
 * @param options - Optional include/exclude globs, CSS prefix and alias handling.
 * @returns The normalized token schema.
 *
 * @example
 * ```ts
 * import { parseTokenSchema } from '@vantradesign/core'
 *
 * const schema = parseTokenSchema('./packages/tokens', {
 *   cssVariablePrefix: 'vt',
 * })
 *
 * schema.byCategory.color             // ['color.brand.primary', ...]
 * schema.byCssVariable['--color-brand-primary']
 * schema.warnings                     // never throws; inspect these in CI
 * ```
 *
 * @public
 */
export function parseTokenSchema(
  repoPath: string,
  options: ParseTokenSchemaOptions = {},
): TokenSchema {
  const rootPath = assertReadableDirectory(repoPath, 'parseTokenSchema')

  const scan = scanRepository(
    rootPath,
    options.include ?? DEFAULT_INCLUDE,
    options.exclude,
    options.maxFiles ?? DEFAULT_MAX_FILES,
  )

  const warnings: TokenParseWarning[] = []
  const sources: TokenSourceFile[] = []
  const rawTokens: RawToken[] = []

  for (const absolutePath of scan.files) {
    const relativePath = toRepoRelative(rootPath, absolutePath)
    const content = readFileSafe(absolutePath)

    if (content === undefined) {
      warnings.push({
        code: 'unreadable-file',
        message: 'File could not be read.',
        filePath: relativePath,
      })
      continue
    }

    const format = extensionOf(absolutePath) === 'css' ? 'css' : 'json'
    const fileTokens =
      format === 'css'
        ? readCssTokens(content, relativePath, warnings)
        : readJsonTokens(content, relativePath, warnings)

    // A stylesheet with no custom properties is not a token source.
    if (fileTokens.length > 0) {
      sources.push({ filePath: relativePath, format, tokenCount: fileTokens.length })
      rawTokens.push(...fileTokens)
    }
  }

  return assemble(rawTokens, sources, warnings, options)
}

/**
 * One canonical token together with every scoped definition found for it.
 */
interface TokenGroup {
  canonicalName: string
  base: RawToken
  segments: string[]
  variants: RawToken[]
}

/**
 * Folds raw definitions into canonical tokens, resolves aliases and builds the
 * lookup indexes.
 */
function assemble(
  rawTokens: readonly RawToken[],
  sources: TokenSourceFile[],
  warnings: TokenParseWarning[],
  options: ParseTokenSchemaOptions,
): TokenSchema {
  const prefix = options.cssVariablePrefix
  const groups = groupTokens(rawTokens, prefix, warnings)

  const rawByName = new Map<string, string>()
  for (const group of groups.values()) {
    rawByName.set(group.canonicalName, group.base.rawValue)
  }

  const resolve =
    options.resolveAliases === false
      ? (_name: string): string | undefined => undefined
      : createResolver(rawByName, prefix, warnings, groups)

  const tokens: DesignToken[] = []

  for (const group of [...groups.values()].sort((a, b) =>
    a.canonicalName.localeCompare(b.canonicalName),
  )) {
    const { base, canonicalName, segments } = group

    const aliases = extractAliases(base.rawValue, prefix)
    for (const alias of aliases) {
      if (rawByName.has(alias)) continue
      warnings.push({
        code: 'unresolved-alias',
        message: `Token "${canonicalName}" references unknown token "${alias}".`,
        filePath: base.filePath,
        tokenName: canonicalName,
      })
    }

    const token: DesignToken = {
      name: canonicalName,
      originalName: base.originalName,
      cssVariable: toCssVariable(canonicalName, prefix),
      path: segments,
      value:
        options.resolveAliases === false
          ? base.rawValue
          : substituteAliases(base.rawValue, prefix, resolve),
      rawValue: base.rawValue,
      category: inferCategory(segments, base.declaredType),
      aliases,
      format: base.format,
      filePath: base.filePath,
    }

    if (base.declaredType !== undefined) token.declaredType = base.declaredType
    if (base.description !== undefined) token.description = base.description
    if (base.scope !== undefined) token.scope = base.scope

    if (group.variants.length > 0) {
      token.variants = group.variants.map((variant): TokenVariant => ({
        scope: variant.scope ?? '',
        value:
          options.resolveAliases === false
            ? variant.rawValue
            : substituteAliases(variant.rawValue, prefix, resolve),
        rawValue: variant.rawValue,
        filePath: variant.filePath,
      }))
    }

    tokens.push(token)
  }

  const byCategory = Object.fromEntries(
    ALL_CATEGORIES.map((category) => [category, [] as string[]]),
  ) as Record<TokenCategory, string[]>

  const byCssVariable: Record<string, string> = {}

  for (const token of tokens) {
    byCategory[token.category].push(token.name)
    byCssVariable[token.cssVariable] = token.name

    // CSS-authored tokens keep their literal property name addressable too, so
    // that a prefixed variable still resolves via the index.
    if (token.format === 'css' && token.originalName.startsWith('--')) {
      byCssVariable[token.originalName] = token.name
    }
  }

  return {
    version: 1,
    tokens,
    byCategory,
    byCssVariable,
    sources: sources.sort((a, b) => a.filePath.localeCompare(b.filePath)),
    warnings,
  }
}

/**
 * Groups raw definitions by canonical name, electing a base definition and
 * treating the rest as scoped variants.
 */
function groupTokens(
  rawTokens: readonly RawToken[],
  prefix: string | undefined,
  warnings: TokenParseWarning[],
): Map<string, TokenGroup> {
  const groups = new Map<string, TokenGroup>()

  for (const raw of rawTokens) {
    const segments =
      raw.format === 'css' ? cssVariableToSegments(raw.originalName, prefix) : raw.segments

    const canonicalName = normalizeTokenName(segments)
    if (canonicalName === '') continue

    const normalizedSegments = canonicalName.split('.')
    const existing = groups.get(canonicalName)

    if (existing === undefined) {
      groups.set(canonicalName, {
        canonicalName,
        base: raw,
        segments: normalizedSegments,
        variants: [],
      })
      continue
    }

    // A themed override (`[data-theme='dark']`) is a variant, never a conflict.
    if (!isBaseScope(raw.scope)) {
      existing.variants.push(raw)
      continue
    }

    if (!isBaseScope(existing.base.scope)) {
      existing.variants.push(existing.base)
      existing.base = raw
      continue
    }

    // Both are base definitions. A JSON source outranks a CSS one, because CSS
    // custom properties are normally *generated from* the JSON token files —
    // seeing the same token in both is expected, not an authoring error.
    if (existing.base.format !== raw.format) {
      if (existing.base.format === 'css' && raw.format === 'json') existing.base = raw
      continue
    }

    if (existing.base.rawValue === raw.rawValue) continue

    warnings.push({
      code: 'duplicate-token',
      message: `Token "${canonicalName}" is defined more than once in the same scope with different values; the first definition wins.`,
      filePath: raw.filePath,
      tokenName: canonicalName,
    })
  }

  return groups
}

/**
 * `true` for scopes that represent a token's unthemed base value.
 */
function isBaseScope(scope: string | undefined): boolean {
  return scope === undefined || BASE_SCOPES.has(scope.trim())
}

/**
 * Builds a memoized alias resolver with cycle detection.
 *
 * A circular alias chain produces a warning and stops resolution rather than
 * recursing forever.
 */
function createResolver(
  rawByName: ReadonlyMap<string, string>,
  prefix: string | undefined,
  warnings: TokenParseWarning[],
  groups: ReadonlyMap<string, TokenGroup>,
): (canonicalName: string) => string | undefined {
  const cache = new Map<string, string | undefined>()
  const inProgress = new Set<string>()
  const reportedCycles = new Set<string>()

  const resolve = (canonicalName: string): string | undefined => {
    if (cache.has(canonicalName)) return cache.get(canonicalName)

    const rawValue = rawByName.get(canonicalName)
    if (rawValue === undefined) return undefined

    if (inProgress.has(canonicalName)) {
      if (!reportedCycles.has(canonicalName)) {
        reportedCycles.add(canonicalName)
        warnings.push({
          code: 'circular-alias',
          message: `Token "${canonicalName}" participates in a circular alias chain; its value is left unresolved.`,
          filePath: groups.get(canonicalName)?.base.filePath ?? '',
          tokenName: canonicalName,
        })
      }
      return undefined
    }

    inProgress.add(canonicalName)
    const resolved = substituteAliases(rawValue, prefix, resolve)
    inProgress.delete(canonicalName)

    cache.set(canonicalName, resolved)
    return resolved
  }

  return resolve
}
