import { describe, expect, it } from 'vitest'
import { parseTokenSchema } from '../src/token-schema'
import type { DesignToken, TokenSchema } from '../src/types'
import { fixture } from './helpers'

const schema = parseTokenSchema(fixture('token-repo'))

/**
 * Looks a token up by canonical name, failing loudly when it is missing.
 */
function token(source: TokenSchema, name: string): DesignToken {
  const match = source.tokens.find((entry) => entry.name === name)
  if (match === undefined) {
    throw new Error(
      `Expected a token named "${name}". Found: ${source.tokens.map((t) => t.name).join(', ')}`,
    )
  }
  return match
}

describe('parseTokenSchema — JSON formats', () => {
  it('reads DTCG $value tokens with descriptions', () => {
    expect(token(schema, 'color.base.blue.500')).toMatchObject({
      value: '#2563eb',
      rawValue: '#2563eb',
      category: 'color',
      declaredType: 'color',
      description: 'Primary blue ramp, step 500.',
      format: 'json',
      filePath: 'tokens/base.tokens.json',
    })
  })

  it('reads Style Dictionary value/type/comment tokens', () => {
    expect(token(schema, 'text.heading')).toMatchObject({
      declaredType: 'color',
      description: 'Default heading colour.',
      category: 'color',
    })
  })

  it('inherits a group-level $type', () => {
    // `spacing` declares `$type: dimension` once, on the group.
    expect(token(schema, 'spacing.sm').declaredType).toBe('dimension')
    expect(token(schema, 'spacing.md').declaredType).toBe('dimension')
  })

  it('serializes composite values instead of dropping them', () => {
    const shadow = token(schema, 'shadow.raised')

    expect(shadow.category).toBe('shadow')
    expect(JSON.parse(shadow.value)).toMatchObject({ offsetY: '1px', blur: '2px' })
  })

  it('does not mistake a serialized composite value for an alias', () => {
    expect(token(schema, 'shadow.raised').aliases).toEqual([])
  })

  it('coerces numeric values to strings', () => {
    expect(token(schema, 'opacity.disabled').value).toBe('0.4')
    expect(token(schema, 'z.index.modal').value).toBe('1000')
  })
})

describe('parseTokenSchema — canonical naming', () => {
  it('splits camelCase so JSON and CSS names converge', () => {
    // JSON `zIndex.modal` and CSS `--z-index-modal` are the same token.
    expect(token(schema, 'z.index.modal').cssVariable).toBe('--z-index-modal')
    expect(schema.byCssVariable['--z-index-modal']).toBe('z.index.modal')
  })

  it('preserves the authored name alongside the canonical one', () => {
    expect(token(schema, 'z.index.modal').originalName).toBe('zIndex.modal')
    expect(token(schema, 'color.brand.on.primary').originalName).toBe('color.brand.onPrimary')
  })

  it('exposes the path segments', () => {
    expect(token(schema, 'color.base.blue.500').path).toEqual(['color', 'base', 'blue', '500'])
  })

  it('recognises a CSS-authored token by its custom property', () => {
    expect(schema.byCssVariable['--font-family-sans']).toBe('font.family.sans')
    expect(token(schema, 'font.family.sans')).toMatchObject({
      format: 'css',
      value: "'Inter', sans-serif",
    })
  })
})

describe('parseTokenSchema — categories', () => {
  it('derives a category from the declared type', () => {
    expect(token(schema, 'spacing.md').category).toBe('spacing')
    expect(token(schema, 'motion.fast').category).toBe('motion')
  })

  it('derives a category from the path when no type is declared', () => {
    expect(token(schema, 'radius.md').category).toBe('radius')
    expect(token(schema, 'opacity.disabled').category).toBe('opacity')
  })

  it('prefers the path over an uninformative declared type', () => {
    // `zIndex.modal` declares `type: number`, which says nothing about its role.
    expect(token(schema, 'z.index.modal').category).toBe('z-index')
  })

  it('resolves borderRadius to radius rather than border', () => {
    expect(token(schema, 'border.radius.md').category).toBe('radius')
  })

  it('groups every token under byCategory exactly once', () => {
    const indexed = Object.values(schema.byCategory).flat()

    expect(indexed.sort()).toEqual(schema.tokens.map((entry) => entry.name).sort())
  })

  it('always exposes every category key, even when empty', () => {
    expect(schema.byCategory.breakpoint).toEqual([])
    expect(schema.byCategory.asset).toEqual([])
  })
})

describe('parseTokenSchema — aliases', () => {
  it('resolves a DTCG alias to a concrete value', () => {
    expect(token(schema, 'color.brand.primary')).toMatchObject({
      rawValue: '{color.base.blue.500}',
      value: '#2563eb',
      aliases: ['color.base.blue.500'],
    })
  })

  it('resolves aliases transitively across files', () => {
    expect(token(schema, 'text.heading').value).toBe('#111827')
  })

  it('resolves a CSS var() alias', () => {
    expect(token(schema, 'color.text.heading')).toMatchObject({
      rawValue: 'var(--color-base-neutral-900)',
      value: '#111827',
    })
  })

  it('leaves raw values untouched when resolution is disabled', () => {
    const unresolved = parseTokenSchema(fixture('token-repo'), { resolveAliases: false })

    expect(token(unresolved, 'color.brand.primary').value).toBe('{color.base.blue.500}')
    expect(token(unresolved, 'color.brand.primary').aliases).toEqual(['color.base.blue.500'])
  })

  it('warns about a circular alias chain instead of hanging', () => {
    const circular = schema.warnings.filter((warning) => warning.code === 'circular-alias')

    expect(circular.length).toBeGreaterThan(0)
    expect(circular[0]?.tokenName).toMatch(/^loop\.[ab]$/)
  })

  it('warns about an alias pointing at a token that does not exist', () => {
    expect(schema.warnings).toContainEqual(
      expect.objectContaining({ code: 'unresolved-alias', tokenName: 'dangling.ref' }),
    )
  })
})

describe('parseTokenSchema — CSS scopes and theme variants', () => {
  it('treats a theme override as a variant, not a duplicate', () => {
    const surface = token(schema, 'color.surface.default')

    expect(surface).toMatchObject({ value: '#ffffff', scope: ':root' })
    expect(surface.variants).toContainEqual(
      expect.objectContaining({ scope: "[data-theme='dark']", value: '#111827' }),
    )
  })

  it('records the at-rule in a variant scope', () => {
    const brand = token(schema, 'color.brand.primary')
    const scopes = (brand.variants ?? []).map((variant) => variant.scope)

    expect(scopes.some((scope) => scope.includes('@media'))).toBe(true)
  })

  it('does not report cross-format duplication as a conflict', () => {
    // `--spacing-md` exists in both the CSS and the JSON source on purpose.
    expect(schema.warnings.filter((warning) => warning.code === 'duplicate-token')).toEqual([])
  })

  it('prefers the JSON definition as the base value', () => {
    expect(token(schema, 'spacing.md').format).toBe('json')
  })

  it('ignores custom properties declared outside a token scope', () => {
    // `.vt-button { background: var(--color-brand-primary) }` is a usage, not a
    // definition, so it must not create a token.
    expect(schema.tokens.every((entry) => entry.name !== 'background')).toBe(true)
  })
})

describe('parseTokenSchema — prefixes', () => {
  it('strips a configured prefix from CSS variable names', () => {
    const prefixed = parseTokenSchema(fixture('token-repo'), { cssVariablePrefix: 'color' })

    // With prefix `color`, `--color-brand-primary` normalizes to `brand.primary`.
    expect(prefixed.tokens.some((entry) => entry.name === 'brand.primary')).toBe(true)
  })

  it('re-applies the prefix when rendering cssVariable', () => {
    const prefixed = parseTokenSchema(fixture('token-repo'), { cssVariablePrefix: 'vt' })

    expect(token(prefixed, 'spacing.md').cssVariable).toBe('--vt-spacing-md')
  })
})

describe('parseTokenSchema — resilience', () => {
  it('never throws on malformed input', () => {
    expect(() => parseTokenSchema(fixture('token-repo'))).not.toThrow()
  })

  it('reports unparseable JSON as a warning and keeps going', () => {
    expect(schema.warnings).toContainEqual(
      expect.objectContaining({ code: 'invalid-json', filePath: 'tokens/malformed.json' }),
    )
    expect(schema.tokens.length).toBeGreaterThan(10)
  })

  it('warns about a descriptor that declares metadata but no value', () => {
    expect(schema.warnings).toContainEqual(
      expect.objectContaining({
        code: 'missing-value',
        tokenName: 'brokenToken.noValueHere',
      }),
    )
  })

  it('never turns token metadata into tokens', () => {
    const names = schema.tokens.map((entry) => entry.name)

    expect(names).not.toContain('broken.token.no.value.here.type')
    expect(names).not.toContain('broken.token.no.value.here.comment')
  })

  it('throws for a missing repository path', () => {
    expect(() => parseTokenSchema(fixture('nope'))).toThrow(/parseTokenSchema.*does not exist/i)
  })

  it('lists only files that actually contained tokens', () => {
    expect(schema.sources.map((source) => source.filePath)).toEqual([
      'styles/theme.css',
      'tokens/base.tokens.json',
      'tokens/circular.tokens.json',
      'tokens/semantic.json',
    ])
  })

  it('reports a token count per source file', () => {
    const css = schema.sources.find((source) => source.filePath === 'styles/theme.css')

    expect(css).toMatchObject({ format: 'css' })
    expect(css?.tokenCount).toBeGreaterThan(0)
  })

  it('is deterministic across runs', () => {
    const again = parseTokenSchema(fixture('token-repo'))

    expect(again).toEqual(schema)
  })

  it('returns sorted tokens', () => {
    const names = schema.tokens.map((entry) => entry.name)

    expect(names).toEqual([...names].sort())
  })

  it('serializes to JSON losslessly', () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
  })
})
