import { parse as parseSfc } from '@vue/compiler-sfc'
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'ts-morph'
import type { PropDefinition } from '../types'
import { getDescription, getLeadingDocComment, membersOfType, sanitizeTypeText } from './ts-utils'

/**
 * The parts of a Vue SFC that this package cares about.
 *
 * @internal
 */
export interface VueScriptExtraction {
  /** Concatenated `<script>` and `<script setup>` content. */
  code: string
  /** `true` when a block declared `lang="tsx"` / `lang="jsx"`. */
  isJsx: boolean
  /** `true` when the file contained no script block at all. */
  isEmpty: boolean
  /**
   * `true` when the SFC could not be parsed.
   *
   * Distinct from {@link VueScriptExtraction.isEmpty}: a template-only component
   * is perfectly valid and must still be reported, whereas a file this parser
   * cannot understand must be skipped.
   */
  failed: boolean
}

/**
 * Maps Vue runtime prop constructors onto TypeScript type text.
 *
 * @internal
 */
const VUE_CONSTRUCTOR_TYPES: Record<string, string> = {
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
  Array: 'unknown[]',
  Object: 'Record<string, unknown>',
  Function: '(...args: unknown[]) => unknown',
  Date: 'Date',
  Symbol: 'symbol',
  BigInt: 'bigint',
}

/**
 * Extracts the script content from a Vue SFC.
 *
 * A malformed SFC yields a failed extraction rather than throwing — one broken
 * component must not abort a whole-repository parse.
 *
 * @internal
 */
export function extractVueScript(content: string, filename: string): VueScriptExtraction {
  try {
    const { descriptor, errors } = parseSfc(content, { filename })

    if (errors.length > 0) return { code: '', isJsx: false, isEmpty: true, failed: true }

    const blocks = [descriptor.script, descriptor.scriptSetup].filter(
      (block): block is NonNullable<typeof block> => block !== null && block !== undefined,
    )

    // A template-only SFC is a real component with no props, not a failure.
    if (blocks.length === 0) {
      return { code: '', isJsx: false, isEmpty: true, failed: descriptor.template === null }
    }

    return {
      code: blocks.map((block) => block.content).join('\n'),
      isJsx: blocks.some((block) => block.lang === 'tsx' || block.lang === 'jsx'),
      isEmpty: false,
      failed: false,
    }
  } catch {
    return { code: '', isJsx: false, isEmpty: true, failed: true }
  }
}

/**
 * Finds every call expression in `sourceFile` whose callee is exactly `name`.
 *
 * @internal
 */
function findCalls(sourceFile: SourceFile, name: string): CallExpression[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === name)
}

/**
 * Reads the object literal passed to `defineComponent({...})` / `export default {...}`.
 *
 * @internal
 */
function getOptionsObject(sourceFile: SourceFile): ObjectLiteralExpression | undefined {
  const exportAssignment = sourceFile.getExportAssignment((assignment) => !assignment.isExportEquals())
  if (exportAssignment === undefined) return undefined

  const expression = exportAssignment.getExpression()

  if (Node.isObjectLiteralExpression(expression)) return expression

  if (Node.isCallExpression(expression)) {
    const argument = expression.getArguments()[0]
    if (argument !== undefined && Node.isObjectLiteralExpression(argument)) return argument
  }

  return undefined
}

/**
 * Reads a string-literal property from an object literal.
 *
 * @internal
 */
function readStringProperty(
  object: ObjectLiteralExpression | undefined,
  propertyName: string,
): string | undefined {
  const property = object?.getProperty(propertyName)
  if (property === undefined || !Node.isPropertyAssignment(property)) return undefined

  const initializer = property.getInitializer()
  if (initializer === undefined || !Node.isStringLiteral(initializer)) return undefined

  return initializer.getLiteralValue()
}

/**
 * Determines the component's registered name from `defineOptions` or the
 * Options API `name` field.
 *
 * @internal
 */
export function extractVueComponentName(sourceFile: SourceFile): string | undefined {
  const defineOptionsCall = findCalls(sourceFile, 'defineOptions')[0]
  const defineOptionsArgument = defineOptionsCall?.getArguments()[0]
  if (defineOptionsArgument !== undefined && Node.isObjectLiteralExpression(defineOptionsArgument)) {
    const name = readStringProperty(defineOptionsArgument, 'name')
    if (name !== undefined) return name
  }

  return readStringProperty(getOptionsObject(sourceFile), 'name')
}

/**
 * Extracts the component's leading description, preferring the doc comment on
 * the default export.
 *
 * @internal
 */
export function extractVueDescription(sourceFile: SourceFile): string | undefined {
  const statements = sourceFile.getStatements()
  for (const statement of statements) {
    if (!Node.isJSDocable(statement)) continue
    const description = getDescription(statement)
    if (description !== undefined) return description
  }
  return undefined
}

/**
 * Extracts the public props of a Vue component.
 *
 * Supports the three declaration styles found in real component libraries:
 * type-based `defineProps<T>()` (optionally wrapped in `withDefaults`),
 * runtime `defineProps({...})`, and the Options API `props` field.
 *
 * @internal
 */
export function extractVueProps(sourceFile: SourceFile): PropDefinition[] {
  const definePropsCall = findCalls(sourceFile, 'defineProps')[0]

  if (definePropsCall !== undefined) {
    const typeArgument = definePropsCall.getTypeArguments()[0]

    if (typeArgument !== undefined) {
      return propsFromTypeArgument(sourceFile, definePropsCall, typeArgument)
    }

    const runtimeArgument = definePropsCall.getArguments()[0]
    if (runtimeArgument !== undefined && Node.isObjectLiteralExpression(runtimeArgument)) {
      return propsFromRuntimeObject(runtimeArgument)
    }

    if (runtimeArgument !== undefined && Node.isArrayLiteralExpression(runtimeArgument)) {
      return propsFromStringArray(runtimeArgument.getElements().map((element) => element.getText()))
    }

    return []
  }

  const optionsProps = getOptionsObject(sourceFile)?.getProperty('props')
  if (optionsProps !== undefined && Node.isPropertyAssignment(optionsProps)) {
    const initializer = optionsProps.getInitializer()
    if (initializer !== undefined && Node.isObjectLiteralExpression(initializer)) {
      return propsFromRuntimeObject(initializer)
    }
    if (initializer !== undefined && Node.isArrayLiteralExpression(initializer)) {
      return propsFromStringArray(initializer.getElements().map((element) => element.getText()))
    }
  }

  return []
}

/**
 * Builds props from `defineProps<T>()`, merging in `withDefaults` defaults.
 *
 * @internal
 */
function propsFromTypeArgument(
  sourceFile: SourceFile,
  definePropsCall: CallExpression,
  typeArgument: Node,
): PropDefinition[] {
  const defaults = collectWithDefaults(sourceFile, definePropsCall)

  return membersOfType(typeArgument.getType(), typeArgument).map((member) => {
    const prop: PropDefinition = {
      name: member.name,
      type: member.type,
      required: !member.optional,
    }

    const defaultValue = defaults.get(member.name)
    if (defaultValue !== undefined) {
      prop.defaultValue = defaultValue
      prop.required = false
    }
    if (member.description !== undefined) prop.description = member.description

    return prop
  })
}

/**
 * Collects the defaults object of `withDefaults(defineProps<T>(), {...})`.
 *
 * @internal
 */
function collectWithDefaults(
  sourceFile: SourceFile,
  definePropsCall: CallExpression,
): Map<string, string> {
  const defaults = new Map<string, string>()

  for (const call of findCalls(sourceFile, 'withDefaults')) {
    const [first, second] = call.getArguments()
    if (first !== definePropsCall) continue
    if (second === undefined || !Node.isObjectLiteralExpression(second)) continue

    for (const property of second.getProperties()) {
      if (!Node.isPropertyAssignment(property)) continue
      const initializer = property.getInitializer()
      if (initializer === undefined) continue
      defaults.set(stripQuotes(property.getName()), initializer.getText())
    }
  }

  return defaults
}

/**
 * Builds props from a runtime props object literal.
 *
 * @internal
 */
function propsFromRuntimeObject(object: ObjectLiteralExpression): PropDefinition[] {
  const props: PropDefinition[] = []

  for (const property of object.getProperties()) {
    if (Node.isShorthandPropertyAssignment(property)) {
      props.push({ name: property.getName(), type: 'unknown', required: false })
      continue
    }

    if (!Node.isPropertyAssignment(property)) continue

    const name = stripQuotes(property.getName())
    const initializer = property.getInitializer()
    if (initializer === undefined) continue

    const prop: PropDefinition = Node.isObjectLiteralExpression(initializer)
      ? propFromDescriptor(name, initializer)
      : { name, type: constructorToType(initializer.getText()), required: false }

    const description = getLeadingDocComment(property)
    if (description !== undefined) prop.description = description

    props.push(prop)
  }

  return props
}

/**
 * Builds one prop from a full `{ type, required, default }` descriptor.
 *
 * @internal
 */
function propFromDescriptor(name: string, descriptor: ObjectLiteralExpression): PropDefinition {
  const typeProperty = descriptor.getProperty('type')
  const requiredProperty = descriptor.getProperty('required')
  const defaultProperty = descriptor.getProperty('default')

  let type = 'unknown'
  if (typeProperty !== undefined && Node.isPropertyAssignment(typeProperty)) {
    type = constructorToType(typeProperty.getInitializer()?.getText() ?? 'unknown')
  }

  let required = false
  if (requiredProperty !== undefined && Node.isPropertyAssignment(requiredProperty)) {
    required = requiredProperty.getInitializer()?.getText() === 'true'
  }

  const prop: PropDefinition = { name, type, required }

  if (defaultProperty !== undefined && Node.isPropertyAssignment(defaultProperty)) {
    const initializer = defaultProperty.getInitializer()
    if (initializer !== undefined) {
      prop.defaultValue = initializer.getText()
      prop.required = false
    }
  }

  return prop
}

/**
 * Builds props from the array-of-names shorthand (`props: ['label', 'size']`).
 *
 * @internal
 */
function propsFromStringArray(entries: readonly string[]): PropDefinition[] {
  return entries
    .map((entry) => stripQuotes(entry))
    .filter((name) => name !== '')
    .map((name) => ({ name, type: 'unknown', required: false }))
}

/**
 * Maps Vue's runtime prop type syntax onto TypeScript type text.
 *
 * @internal
 */
export function constructorToType(text: string): string {
  const trimmed = text.trim()

  const propTypeMatch = /PropType<([\s\S]+)>\s*$/.exec(trimmed)
  if (propTypeMatch?.[1] !== undefined) return sanitizeTypeText(propTypeMatch[1])

  const direct = VUE_CONSTRUCTOR_TYPES[trimmed]
  if (direct !== undefined) return direct

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const members = trimmed
      .slice(1, -1)
      .split(',')
      .map((entry) => constructorToType(entry))
      .filter((entry) => entry !== '')
    if (members.length > 0) return [...new Set(members)].join(' | ')
  }

  return sanitizeTypeText(trimmed)
}

/**
 * Removes surrounding quotes from an object-literal key.
 *
 * @internal
 */
function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, '')
}
