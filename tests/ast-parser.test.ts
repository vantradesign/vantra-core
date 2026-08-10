import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseComponents } from '../src/ast-parser'
import { componentNamed, fixture, propNamed } from './helpers'

describe('parseComponents — Vue SFC', () => {
  const components = parseComponents(fixture('vue-lib'))

  it('extracts type-based defineProps with withDefaults', () => {
    const button = componentNamed(components, 'Button')

    expect(button.kind).toBe('vue-sfc')
    expect(button.props.map((prop) => prop.name)).toEqual([
      'variant',
      'icon',
      'disabled',
      'label',
    ])

    expect(propNamed(button, 'variant')).toMatchObject({
      type: 'ButtonVariant',
      required: false,
      defaultValue: "'primary'",
      description: 'Visual emphasis of the button.',
    })

    expect(propNamed(button, 'label')).toMatchObject({ type: 'string', required: true })
    expect(propNamed(button, 'icon').required).toBe(false)
  })

  it('extracts runtime object props from the Options API', () => {
    const icon = componentNamed(components, 'VtIcon')

    expect(icon.kind).toBe('vue-sfc')
    expect(propNamed(icon, 'name')).toMatchObject({ type: 'string', required: true })
    expect(propNamed(icon, 'size')).toMatchObject({
      type: 'string',
      required: false,
      defaultValue: "'1rem'",
    })
    // Shorthand `rotation: Number` is optional with no default.
    expect(propNamed(icon, 'rotation')).toMatchObject({ type: 'number', required: false })
  })

  it('collects token references from template, script and style blocks', () => {
    const button = componentNamed(components, 'Button')

    expect(button.tokenReferences).toEqual([
      '--color-brand-primary',
      '--color-text-inverse',
      '--radius-md',
      '--spacing-md',
      '--spacing-sm',
    ])
  })

  it('reports source locations relative to the .vue file, not the extracted script', () => {
    const button = componentNamed(components, 'Button')
    const icon = componentNamed(components, 'VtIcon')

    // Button.vue opens `<script setup>` on line 8, so its script body starts on 9.
    expect(button.location).toEqual({ filePath: 'src/Button.vue', line: 9, column: 1 })

    // Icon.vue opens `<script>` on line 5, so its script body starts on 6.
    expect(icon.location).toEqual({ filePath: 'src/Icon.vue', line: 6, column: 1 })
  })

  it('offsets nested declaration locations into the .vue file as well', () => {
    const sfcLines = readFileSync(join(fixture('vue-lib'), 'src/Icon.vue'), 'utf8').split('\n')
    const icon = componentNamed(components, 'VtIcon')

    // Every reported line must exist in the .vue file, never past its end.
    expect(icon.location.line).toBeLessThanOrEqual(sfcLines.length)
    expect(sfcLines[icon.location.line - 1]).toContain('defineComponent')
  })

  it('distinguishes type-only imports and resolves relative specifiers', () => {
    const button = componentNamed(components, 'Button')

    const typeImport = button.imports.find((entry) => entry.names.includes('ButtonVariant'))
    expect(typeImport).toMatchObject({
      isTypeOnly: true,
      isExternal: false,
      resolvedPath: 'src/composables/useTheme.ts',
    })

    const sfcImport = button.imports.find((entry) => entry.moduleSpecifier === './Icon.vue')
    expect(sfcImport).toMatchObject({ resolvedPath: 'src/Icon.vue', isExternal: false })
  })

  it('marks bare package specifiers as external', () => {
    const icon = componentNamed(components, 'VtIcon')
    const vueImport = icon.imports.find((entry) => entry.moduleSpecifier === 'vue')

    expect(vueImport).toMatchObject({ isExternal: true })
    expect(vueImport?.resolvedPath).toBeUndefined()
  })

  it('captures the exported surface of plain TypeScript modules', () => {
    const composable = componentNamed(components, 'useTheme')

    expect(composable.kind).toBe('module')
    expect(composable.functions.map((entry) => entry.name)).toEqual(['useTheme', 'toCssVariable'])
    expect(composable.types.map((entry) => entry.name)).toEqual(['Theme', 'ButtonVariant'])
    expect(composable.values.map((entry) => entry.name)).toEqual([
      'DEFAULT_THEME_NAME',
      'AVAILABLE_THEMES',
    ])
  })

  it('records re-exports from a barrel file', () => {
    const barrel = componentNamed(components, 'index')

    expect(barrel.reExports.length).toBeGreaterThan(0)
    expect(barrel.reExports.every((entry) => entry.isExternal === false)).toBe(true)
  })
})

describe('parseComponents — React', () => {
  const components = parseComponents(fixture('react-lib'))

  it('flattens props inherited through interface extension', () => {
    const button = componentNamed(components, 'Button')

    expect(button.kind).toBe('react')
    expect(button.props.map((prop) => prop.name)).toEqual([
      'label',
      'variant',
      'disabled',
      'onPress',
      'className',
      'testId',
    ])

    // `className` and `testId` come from BaseProps.
    expect(propNamed(button, 'className')).toMatchObject({
      type: 'string',
      required: false,
      description: 'Extra class names appended to the root element.',
    })
  })

  it('reads defaults from destructuring patterns', () => {
    const button = componentNamed(components, 'Button')

    expect(propNamed(button, 'variant').defaultValue).toBe("'primary'")
    expect(propNamed(button, 'disabled').defaultValue).toBe('false')
    expect(propNamed(button, 'onPress').defaultValue).toBeUndefined()
  })

  it('finds every component declared in one file', () => {
    const fromCard = components.filter((entry) => entry.filePath === 'src/Card.tsx')

    expect(fromCard.map((entry) => entry.name).sort()).toEqual(['Card', 'CardHeader'])
    expect(fromCard.every((entry) => entry.kind === 'react')).toBe(true)
  })

  it('resolves props for function declarations and arrow components alike', () => {
    const card = componentNamed(components, 'Card')
    const header = componentNamed(components, 'CardHeader')

    expect(propNamed(card, 'elevation').defaultValue).toBe('1')
    expect(propNamed(header, 'level')).toMatchObject({
      type: '1 | 2 | 3',
      defaultValue: '2',
    })
  })

  it('marks the default export', () => {
    const card = componentNamed(components, 'Card')
    expect(card.isDefaultExport).toBe(true)

    const header = componentNamed(components, 'CardHeader')
    expect(header.isDefaultExport).toBe(false)
  })

  it('ignores token names truncated by template interpolation', () => {
    const card = componentNamed(components, 'Card')

    // `var(--shadow-${elevation})` is dynamic; "--shadow-" is not a real token.
    expect(card.tokenReferences).toEqual(['--color-text-heading'])
    expect(card.tokenReferences).not.toContain('--shadow-')
  })

  it('classifies a hooks file as a module, not a component', () => {
    const hooks = componentNamed(components, 'useToggle')

    expect(hooks.kind).toBe('module')
    expect(hooks.functions.map((entry) => entry.name)).toEqual(['useToggle', 'resolveColorToken'])
    expect(hooks.functions.find((entry) => entry.name === 'resolveColorToken')?.isAsync).toBe(true)
  })

  it('captures interfaces, unions and enums with their members', () => {
    const types = componentNamed(components, 'types')

    expect(types.types.map((entry) => entry.name)).toEqual(['BaseProps', 'Variant', 'Size'])

    const base = types.types.find((entry) => entry.name === 'BaseProps')
    expect(base?.kind).toBe('interface')
    expect(base?.members?.map((member) => member.name)).toEqual(['className', 'testId'])

    const size = types.types.find((entry) => entry.name === 'Size')
    expect(size?.kind).toBe('enum')
    expect(size?.members?.map((member) => member.name)).toEqual(['Small', 'Medium', 'Large'])
  })
})

describe('parseComponents — React wrappers and class components', () => {
  const components = parseComponents(fixture('react-lib')).filter(
    (entry) => entry.filePath === 'src/Advanced.tsx',
  )

  it('reads props from a forwardRef type argument, not the untyped inner parameter', () => {
    const input = componentNamed(components, 'Input')

    // forwardRef<HTMLInputElement, InputProps>: props are the *second* argument.
    expect(propNamed(input, 'value')).toMatchObject({ type: 'string', required: true })
    expect(propNamed(input, 'placeholder')).toMatchObject({ type: 'string', required: false })
    expect(propNamed(input, 'className').description).toBe(
      'Extra class names appended to the root element.',
    )
  })

  it('reads props from a memo-wrapped component', () => {
    const badge = componentNamed(components, 'Badge')

    expect(propNamed(badge, 'text').required).toBe(true)
    expect(propNamed(badge, 'tone')).toMatchObject({
      type: "'info' | 'warning'",
      defaultValue: "'info'",
    })
  })

  it('detects a class component and reads props from its heritage clause', () => {
    const legacy = componentNamed(components, 'Legacy')

    expect(legacy.kind).toBe('react')
    expect(legacy.props.map((prop) => prop.name)).toEqual(['text', 'tone'])
  })

  it('does not double-report a class component as an exported type', () => {
    const legacy = componentNamed(components, 'Legacy')

    expect(legacy.types.map((entry) => entry.name)).not.toContain('Legacy')
  })

  it('handles a component with no props', () => {
    expect(componentNamed(components, 'Divider').props).toEqual([])
  })

  it('handles props declared inline rather than as a named type', () => {
    expect(propNamed(componentNamed(components, 'Spacer'), 'size')).toMatchObject({
      type: 'number',
      defaultValue: '8',
      required: false,
    })
  })

  it('reads legacy Component.defaultProps assignments', () => {
    const banner = componentNamed(components, 'Banner')

    expect(propNamed(banner, 'level')).toMatchObject({
      defaultValue: "'info'",
      required: false,
    })
    expect(propNamed(banner, 'message').required).toBe(true)
  })
})

describe('parseComponents — Vue Options API variants', () => {
  const components = parseComponents(fixture('vue-lib'))

  it('reads props from a plain object-literal default export', () => {
    const panel = componentNamed(components, 'VtPanel')

    expect(panel.kind).toBe('vue-sfc')
    expect(propNamed(panel, 'heading')).toMatchObject({ type: 'string', required: true })
    expect(propNamed(panel, 'collapsed')).toMatchObject({
      type: 'boolean',
      defaultValue: 'false',
    })
  })

  it('keeps a factory default verbatim', () => {
    expect(propNamed(componentNamed(components, 'VtPanel'), 'meta')).toMatchObject({
      type: 'Record<string, unknown>',
      defaultValue: '() => ({})',
    })
  })

  it('treats a template-only SFC as a real component with no props', () => {
    const divider = componentNamed(components, 'Divider')

    expect(divider.kind).toBe('vue-sfc')
    expect(divider.props).toEqual([])
    expect(divider.tokenReferences).toEqual(['--color-border-subtle'])
  })
})

describe('parseComponents — TypeScript signatures', () => {
  const components = parseComponents(fixture('monorepo'), {
    aliases: { '@/': 'packages/ui/src/' },
  })
  const signatures = componentNamed(components, 'signatures')

  it('captures optional, defaulted and rest parameters', () => {
    const format = signatures.functions.find((entry) => entry.name === 'formatLabel')

    expect(format?.parameters).toEqual([
      { name: 'value', type: 'string', optional: false, rest: false },
      { name: 'options', type: 'FormatOptions', optional: true, rest: false, defaultValue: '{}' },
      { name: 'extras', type: 'string[]', optional: false, rest: true },
    ])
    expect(format?.returnType).toBe('string')
  })

  it('preserves generic parameter and return types', () => {
    const pick = signatures.functions.find((entry) => entry.name === 'pick')

    expect(pick?.returnType).toBe('TRecord[TKey]')
    expect(pick?.parameters.map((parameter) => parameter.type)).toEqual(['TRecord', 'TKey'])
  })

  it('flags async functions', () => {
    const delay = signatures.functions.find((entry) => entry.name === 'delay')

    expect(delay).toMatchObject({ isAsync: true, returnType: 'Promise<void>' })
  })

  it('captures generator functions', () => {
    expect(
      signatures.functions.find((entry) => entry.name === 'spacingSteps')?.returnType,
    ).toBe('Generator<string>')
  })

  it('reports an exported class as a type', () => {
    expect(signatures.types.map((entry) => entry.name)).toContain('SpacingRule')
  })
})

describe('parseComponents — module resolution edge cases', () => {
  const components = parseComponents(fixture('monorepo'), {
    aliases: { '@/': 'packages/ui/src/' },
  })
  const signatures = componentNamed(components, 'signatures')

  const importOf = (specifier: string) =>
    signatures.imports.find((entry) => entry.moduleSpecifier === specifier)

  it('resolves a bare directory import to its index file', () => {
    expect(importOf('./utils')?.resolvedPath).toBe('packages/ui/src/utils/index.ts')
  })

  it('maps an explicit .js specifier onto the .ts source', () => {
    expect(importOf('./utils/text.js')?.resolvedPath).toBe('packages/ui/src/utils/text.ts')
  })

  it('resolves deep relative paths across packages', () => {
    expect(importOf('../../tokens/src/index')).toMatchObject({
      isExternal: false,
      resolvedPath: 'packages/tokens/src/index.ts',
    })
  })

  it('leaves a genuine third-party package external', () => {
    expect(importOf('lodash-es')).toMatchObject({ isExternal: true })
    expect(importOf('lodash-es')?.resolvedPath).toBeUndefined()
  })

  it('falls back to the package manifest for a non-standard entry point', () => {
    // @fixture/icons has no src/index.ts; only its `main` field points at the entry.
    expect(importOf('@fixture/icons')).toMatchObject({
      isExternal: false,
      resolvedPackage: '@fixture/icons',
      resolvedPath: 'packages/icons/lib/entry.ts',
    })
  })

  it('resolves a subpath into a workspace package', () => {
    expect(importOf('@fixture/tokens/src/index')).toMatchObject({
      isExternal: false,
      resolvedPackage: '@fixture/tokens',
      resolvedPath: 'packages/tokens/src/index.ts',
    })
  })
})

describe('parseComponents — monorepo resolution', () => {
  const components = parseComponents(fixture('monorepo'), {
    aliases: { '@/': 'packages/ui/src/' },
  })

  it('attributes each component to its owning package', () => {
    expect(componentNamed(components, 'VtAlert').packageName).toBe('@fixture/ui')
    expect(componentNamed(components, 'index').packageName).toBe('@fixture/tokens')
  })

  it('resolves workspace package specifiers to real files', () => {
    const alert = componentNamed(components, 'VtAlert')
    const crossPackage = alert.imports.find(
      (entry) => entry.moduleSpecifier === '@fixture/tokens' && !entry.isTypeOnly,
    )

    expect(crossPackage).toMatchObject({
      isExternal: false,
      resolvedPath: 'packages/tokens/src/index.ts',
      resolvedPackage: '@fixture/tokens',
    })
  })

  it('resolves configured path aliases', () => {
    const alert = componentNamed(components, 'VtAlert')
    const aliased = alert.imports.find((entry) => entry.moduleSpecifier === '@/utils/text')

    expect(aliased).toMatchObject({
      isExternal: false,
      resolvedPath: 'packages/ui/src/utils/text.ts',
    })
  })

  it('honours defineOptions for the component name', () => {
    const alert = componentNamed(components, 'VtAlert')

    expect(alert.filePath).toBe('packages/ui/src/Alert.vue')
    expect(alert.props.map((prop) => prop.name)).toEqual(['title', 'message', 'severity'])
  })
})

describe('parseComponents — resilience', () => {
  it('skips unparseable files and still returns the healthy ones', () => {
    const components = parseComponents(fixture('malformed'))

    expect(components.map((entry) => entry.name)).toContain('Healthy')
    expect(propNamed(componentNamed(components, 'Healthy'), 'text').required).toBe(true)
  })

  it('throws a helpful error for a missing repository path', () => {
    expect(() => parseComponents(fixture('does-not-exist'))).toThrow(
      /parseComponents.*does not exist/i,
    )
  })

  it('throws when handed a file instead of a directory', () => {
    expect(() => parseComponents(fixture('vue-lib/package.json'))).toThrow(/not a directory/i)
  })

  it('returns results sorted by file path then name', () => {
    const components = parseComponents(fixture('react-lib'))
    const keys = components.map((entry) => `${entry.filePath}#${entry.name}`)

    expect(keys).toEqual([...keys].sort())
  })

  it('respects the maxFiles guard rail', () => {
    const limited = parseComponents(fixture('react-lib'), { maxFiles: 1 })
    const full = parseComponents(fixture('react-lib'))

    expect(limited.length).toBeGreaterThan(0)
    expect(limited.length).toBeLessThan(full.length)
  })

  it('honours custom include patterns', () => {
    const onlyTsx = parseComponents(fixture('react-lib'), { include: ['**/*.tsx'] })

    expect(onlyTsx.every((entry) => entry.filePath.endsWith('.tsx'))).toBe(true)
  })

  it('produces stable ids across repeated runs', () => {
    const first = parseComponents(fixture('vue-lib')).map((entry) => entry.id)
    const second = parseComponents(fixture('vue-lib')).map((entry) => entry.id)

    expect(second).toEqual(first)
  })
})
