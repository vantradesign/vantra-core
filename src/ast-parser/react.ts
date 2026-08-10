import {
  Node,
  SyntaxKind,
  type ObjectLiteralExpression,
  type SourceFile,
  type Type,
  type TypeNode,
} from 'ts-morph'
import type { PropDefinition } from '../types'
import { isPascalCase } from '../internal/paths'
import { containsJsx, getLeadingDocComment, membersOfType } from './ts-utils'

/**
 * Type names that mark a variable as a React component even when its body
 * contains no literal JSX (e.g. a component that only forwards children).
 */
const REACT_COMPONENT_TYPE_PATTERN =
  /\b(?:React\s*\.\s*)?(?:FC|VFC|FunctionComponent|VoidFunctionComponent|ComponentType|ForwardRefExoticComponent|MemoExoticComponent)\b/

/**
 * Higher-order helpers whose return value is still a component.
 */
const REACT_WRAPPER_CALLEES = /^(?:React\s*\.\s*)?(?:memo|forwardRef|lazy)$/

/**
 * Decides whether an exported binding is a React component.
 *
 * The heuristic deliberately requires a PascalCase name — that is the only
 * signal React itself uses to distinguish components from plain functions — and
 * then one corroborating signal: literal JSX, a React component type
 * annotation, or a `memo`/`forwardRef` wrapper.
 *
 * @internal
 */
export function isReactComponent(name: string, node: Node, typeNode?: TypeNode): boolean {
  if (!isPascalCase(name)) return false

  if (typeNode !== undefined && REACT_COMPONENT_TYPE_PATTERN.test(typeNode.getText())) {
    return true
  }

  if (containsJsx(node)) return true

  let current: Node | undefined = node
  while (current !== undefined && Node.isCallExpression(current)) {
    if (REACT_WRAPPER_CALLEES.test(current.getExpression().getText().replace(/\s+/g, ''))) {
      return true
    }
    current = current.getArguments()[0]
  }

  return false
}

/**
 * Extracts the props of a React component.
 *
 * Resolution order mirrors how React authors actually declare props:
 * 1. an explicit `React.FC<Props>` / `ForwardRefExoticComponent<Props>` type argument,
 * 2. the first parameter's type annotation,
 * 3. destructuring defaults and a `Component.defaultProps` assignment, which
 *    refine the results of 1 and 2 rather than replacing them.
 *
 * @internal
 */
export function extractReactProps(
  componentName: string,
  functionNode: Node,
  sourceFile: SourceFile,
  typeNode?: TypeNode,
): PropDefinition[] {
  const propsType = resolvePropsType(functionNode, typeNode)
  const defaults = new Map<string, string>([
    ...collectDestructuringDefaults(functionNode),
    ...collectDefaultPropsAssignment(componentName, sourceFile),
  ])

  if (propsType === undefined) {
    // No type information at all: fall back to whatever the destructuring
    // pattern reveals, so that untyped JS components still expose a surface.
    return [...defaults.keys()].sort().map((name) => {
      const prop: PropDefinition = { name, type: 'unknown', required: false }
      const defaultValue = defaults.get(name)
      if (defaultValue !== undefined) prop.defaultValue = defaultValue
      return prop
    })
  }

  const members = membersOfType(propsType.type, propsType.node)

  const props = members.map((member) => {
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

  // Destructured props that the type does not mention (common with `...rest`
  // spreads onto intrinsic elements) are still part of the observable surface.
  const known = new Set(props.map((prop) => prop.name))
  for (const [name, defaultValue] of defaults) {
    if (known.has(name)) continue
    props.push({ name, type: 'unknown', required: false, defaultValue })
  }

  return props
}

/**
 * Finds the type describing the component's props.
 */
function resolvePropsType(
  functionNode: Node,
  typeNode?: TypeNode,
): { type: Type; node: Node } | undefined {
  if (typeNode !== undefined) {
    const fromAnnotation = firstTypeArgument(typeNode)
    if (fromAnnotation !== undefined) {
      return { type: fromAnnotation.getType(), node: fromAnnotation }
    }
  }

  // `class X extends React.Component<Props>` states its props on the heritage
  // clause rather than on a parameter.
  const fromClassHeritage = reactClassPropsType(functionNode)
  if (fromClassHeritage !== undefined) {
    return { type: fromClassHeritage.getType(), node: fromClassHeritage }
  }

  // `forwardRef<HTMLInputElement, Props>(fn)` states the props type on the
  // wrapper, not on the inner function, whose parameter is usually untyped.
  const fromWrapper = wrapperTypeArgument(functionNode)
  if (fromWrapper !== undefined) {
    return { type: fromWrapper.getType(), node: fromWrapper }
  }

  if (Node.isSignaturedDeclaration(functionNode)) {
    const parameter = functionNode.getParameters()[0]
    const parameterTypeNode = parameter?.getTypeNode()

    if (parameterTypeNode !== undefined) {
      return { type: parameterTypeNode.getType(), node: parameterTypeNode }
    }

    if (parameter !== undefined) {
      try {
        const inferred = parameter.getType()
        if (!inferred.isAny() && !inferred.isUnknown()) {
          return { type: inferred, node: parameter }
        }
      } catch {
        return undefined
      }
    }
  }

  return undefined
}

/**
 * Returns the first type argument of `React.FC<Props>`-style annotations.
 */
function firstTypeArgument(typeNode: TypeNode): TypeNode | undefined {
  if (Node.isTypeReference(typeNode)) {
    return typeNode.getTypeArguments()[0]
  }
  return undefined
}

/**
 * Reads the props type argument off an enclosing `forwardRef` / `memo` call.
 *
 * `forwardRef` takes `<Ref, Props>`, every other wrapper takes `<Props>` first.
 */
function wrapperTypeArgument(functionNode: Node): TypeNode | undefined {
  let current: Node | undefined = functionNode.getParent()

  while (current !== undefined && Node.isCallExpression(current)) {
    const callee = current.getExpression().getText().replace(/\s+/g, '')

    if (REACT_WRAPPER_CALLEES.test(callee)) {
      const typeArguments = current.getTypeArguments()
      const index = /forwardRef$/.test(callee) ? 1 : 0
      const candidate = typeArguments[index]
      if (candidate !== undefined) return candidate
    }

    current = current.getParent()
  }

  return undefined
}

/**
 * Base classes that make a class a React component.
 */
const REACT_COMPONENT_BASE = /^(?:React\.)?(?:Pure)?Component$/

/**
 * Reads the props type argument from `class X extends React.Component<Props>`.
 */
function reactClassPropsType(declaration: Node): TypeNode | undefined {
  if (!Node.isClassDeclaration(declaration)) return undefined

  const heritage = declaration.getExtends()
  if (heritage === undefined) return undefined

  const base = heritage.getExpression().getText().replace(/\s+/g, '')
  if (!REACT_COMPONENT_BASE.test(base)) return undefined

  return heritage.getTypeArguments()[0]
}

/**
 * `true` when a class declaration extends a React component base class.
 *
 * @internal
 */
export function isReactClassComponent(declaration: Node): boolean {
  if (!Node.isClassDeclaration(declaration)) return false

  const heritage = declaration.getExtends()
  if (heritage === undefined) return false

  return REACT_COMPONENT_BASE.test(heritage.getExpression().getText().replace(/\s+/g, ''))
}

/**
 * Collects defaults from a destructured props parameter: `({ size = 'md' })`.
 */
function collectDestructuringDefaults(functionNode: Node): Map<string, string> {
  const defaults = new Map<string, string>()
  if (!Node.isSignaturedDeclaration(functionNode)) return defaults

  const parameter = functionNode.getParameters()[0]
  const nameNode = parameter?.getNameNode()
  if (nameNode === undefined || !Node.isObjectBindingPattern(nameNode)) return defaults

  for (const element of nameNode.getElements()) {
    if (element.getDotDotDotToken() !== undefined) continue

    const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName()
    const initializer = element.getInitializer()

    defaults.set(
      propertyName.replace(/^['"`]|['"`]$/g, ''),
      initializer?.getText() ?? '',
    )
  }

  // An element without a default still names a prop, but must not be reported
  // as having a default value of `''`.
  for (const [name, value] of [...defaults]) {
    if (value === '') defaults.delete(name)
  }

  return defaults
}

/**
 * Collects defaults from a legacy `Button.defaultProps = { ... }` assignment.
 */
function collectDefaultPropsAssignment(
  componentName: string,
  sourceFile: SourceFile,
): Map<string, string> {
  const defaults = new Map<string, string>()

  for (const statement of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (statement.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue

    const left = statement.getLeft()
    if (left.getText().replace(/\s+/g, '') !== `${componentName}.defaultProps`) continue

    const right = statement.getRight()
    if (!Node.isObjectLiteralExpression(right)) continue

    for (const [name, value] of readObjectLiteral(right)) {
      defaults.set(name, value)
    }
  }

  return defaults
}

/**
 * Flattens an object literal into a name/source-text map.
 */
function readObjectLiteral(object: ObjectLiteralExpression): Map<string, string> {
  const entries = new Map<string, string>()

  for (const property of object.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue
    const initializer = property.getInitializer()
    if (initializer === undefined) continue
    entries.set(property.getName().replace(/^['"`]|['"`]$/g, ''), initializer.getText())
  }

  return entries
}

/**
 * Reads the doc comment attached to a destructured prop inside the parameter
 * pattern, used when the props type itself is undocumented.
 *
 * @internal
 */
export function destructuredPropDescription(
  functionNode: Node,
  propName: string,
): string | undefined {
  if (!Node.isSignaturedDeclaration(functionNode)) return undefined

  const nameNode = functionNode.getParameters()[0]?.getNameNode()
  if (nameNode === undefined || !Node.isObjectBindingPattern(nameNode)) return undefined

  for (const element of nameNode.getElements()) {
    const name = element.getPropertyNameNode()?.getText() ?? element.getName()
    if (name.replace(/^['"`]|['"`]$/g, '') !== propName) continue
    return getLeadingDocComment(element)
  }

  return undefined
}
