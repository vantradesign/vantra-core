import {
  Node,
  SymbolFlags,
  SyntaxKind,
  type ClassDeclaration,
  type EnumDeclaration,
  type ExportedDeclarations,
  type FunctionDeclaration,
  type InterfaceDeclaration,
  type JSDocableNode,
  type ParameterDeclaration,
  type SourceFile,
  type Type,
  type TypeAliasDeclaration,
  type TypeNode,
} from 'ts-morph'
import type {
  ExportedFunction,
  ExportedType,
  FunctionParameter,
  ModuleReference,
  SourceLocation,
  TypeMember,
} from '../types'

/**
 * Upper bound on any single rendered type string.
 *
 * Deeply inferred types can render into many kilobytes, which would bloat every
 * persisted graph. Truncated types keep a visible marker so consumers never
 * mistake them for complete definitions.
 *
 * @internal
 */
const MAX_TYPE_TEXT_LENGTH = 800

/**
 * Removes machine-specific `import("/abs/path")` prefixes that the TypeScript
 * checker emits for inferred types, and collapses whitespace.
 *
 * Without this, a type rendered on a developer's Mac would differ from the same
 * type rendered on a Linux CI runner, breaking artefact comparison.
 *
 * @internal
 */
export function sanitizeTypeText(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return 'unknown'

  const cleaned = value
    .replace(/import\((?:"[^"]*"|'[^']*')\)\./g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned.length <= MAX_TYPE_TEXT_LENGTH) return cleaned
  return `${cleaned.slice(0, MAX_TYPE_TEXT_LENGTH)}… /* truncated */`
}

/**
 * Renders a node's declared type, falling back to the checker-inferred type.
 *
 * @internal
 */
export function renderType(typeNode: TypeNode | undefined, fallbackNode?: Node): string {
  if (typeNode !== undefined) return sanitizeTypeText(typeNode.getText())
  if (fallbackNode === undefined) return 'unknown'

  try {
    return sanitizeTypeText(fallbackNode.getType().getText(fallbackNode))
  } catch {
    return 'unknown'
  }
}

/**
 * Renders a checker {@link Type} relative to `enclosingNode`.
 *
 * @internal
 */
export function renderCheckerType(type: Type, enclosingNode?: Node): string {
  try {
    return sanitizeTypeText(type.getText(enclosingNode))
  } catch {
    return 'unknown'
  }
}

/**
 * Extracts the leading TSDoc/JSDoc description of a node, if any.
 *
 * @internal
 */
export function getDescription(node: JSDocableNode | undefined): string | undefined {
  if (node === undefined) return undefined

  try {
    const docs = node.getJsDocs()
    for (let index = docs.length - 1; index >= 0; index -= 1) {
      const text = docs[index]?.getDescription().trim()
      if (text !== undefined && text !== '') return text
    }
  } catch {
    // Not every node shape supports JSDoc lookup; absence of docs is not an error.
  }

  return undefined
}

/**
 * Reads a leading `/** ... *\/` block comment from any node.
 *
 * Needed for nodes that ts-morph does not model as JSDocable — most notably
 * `PropertyAssignment`, which is how Vue's runtime `props: { ... }` options and
 * React `defaultProps` document individual entries.
 *
 * @internal
 */
export function getLeadingDocComment(node: Node): string | undefined {
  let ranges: ReturnType<Node['getLeadingCommentRanges']>
  try {
    ranges = node.getLeadingCommentRanges()
  } catch {
    return undefined
  }

  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const text = ranges[index]?.getText() ?? ''
    if (!text.startsWith('/**')) continue

    const body = text
      .replace(/^\/\*\*/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\*/, '').trim())
      .filter((line) => !line.startsWith('@'))
      .join(' ')
      .trim()

    if (body !== '') return body
  }

  return undefined
}

/**
 * Builds a repository-relative {@link SourceLocation} for `node`.
 *
 * @internal
 */
export function locationOf(node: Node, filePath: string): SourceLocation {
  try {
    const { line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart())
    return { filePath, line, column }
  } catch {
    return { filePath, line: 1, column: 1 }
  }
}

/**
 * `true` when the identifier follows the React/Vue hook & composable convention.
 *
 * @internal
 */
export function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name)
}

/**
 * `true` when the node's body contains JSX, i.e. it renders a React element.
 *
 * @internal
 */
export function containsJsx(node: Node): boolean {
  return (
    node.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
    node.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    node.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined
  )
}

/* -------------------------------------------------------------------------- */
/* Properties                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolves every property of `type` into {@link TypeMember}s.
 *
 * The checker is used rather than raw syntax so that inherited members
 * (`interface ButtonProps extends BaseProps`) and members declared in another
 * file are both included.
 *
 * @internal
 */
export function membersOfType(type: Type, enclosingNode: Node): TypeMember[] {
  const members: TypeMember[] = []

  let properties: ReturnType<Type['getProperties']>
  try {
    properties = type.getProperties()
  } catch {
    return members
  }

  for (const property of properties) {
    const name = property.getName()
    if (name.startsWith('__')) continue

    const declaration = property.getValueDeclaration() ?? property.getDeclarations()[0]

    let typeText: string
    const declaredTypeNode =
      declaration !== undefined &&
      (Node.isPropertySignature(declaration) || Node.isPropertyDeclaration(declaration))
        ? declaration.getTypeNode()
        : undefined

    if (declaredTypeNode !== undefined) {
      typeText = sanitizeTypeText(declaredTypeNode.getText())
    } else {
      try {
        typeText = renderCheckerType(
          property.getTypeAtLocation(declaration ?? enclosingNode),
          declaration ?? enclosingNode,
        )
      } catch {
        typeText = 'unknown'
      }
    }

    const member: TypeMember = {
      name,
      type: typeText,
      optional: property.hasFlags(SymbolFlags.Optional),
    }

    const description =
      declaration !== undefined && Node.isJSDocable(declaration)
        ? getDescription(declaration)
        : undefined
    if (description !== undefined) member.description = description

    members.push(member)
  }

  return members
}

/* -------------------------------------------------------------------------- */
/* Functions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Converts a parameter declaration into its public representation.
 *
 * @internal
 */
export function toFunctionParameter(parameter: ParameterDeclaration): FunctionParameter {
  const initializer = parameter.getInitializer()

  const result: FunctionParameter = {
    name: parameter.getNameNode().getText(),
    type: renderType(parameter.getTypeNode(), parameter),
    optional: parameter.hasQuestionToken() || initializer !== undefined,
    rest: parameter.isRestParameter(),
  }

  if (initializer !== undefined) result.defaultValue = initializer.getText()

  return result
}

/**
 * Renders a function-like node's return type.
 *
 * @internal
 */
function renderReturnType(node: Node): string {
  if (Node.isReturnTyped(node)) {
    const annotated = node.getReturnTypeNode()
    if (annotated !== undefined) return sanitizeTypeText(annotated.getText())
  }

  try {
    if (Node.isSignaturedDeclaration(node)) {
      return sanitizeTypeText(node.getReturnType().getText(node))
    }
  } catch {
    // Fall through.
  }

  return 'unknown'
}

/**
 * Builds an {@link ExportedFunction} from any function-like declaration.
 *
 * @internal
 */
export function toExportedFunction(
  name: string,
  node: Node,
  filePath: string,
  isDefaultExport: boolean,
  docNode?: JSDocableNode,
): ExportedFunction | undefined {
  if (!Node.isSignaturedDeclaration(node)) return undefined

  const result: ExportedFunction = {
    name,
    parameters: node.getParameters().map(toFunctionParameter),
    returnType: renderReturnType(node),
    isAsync: Node.isAsyncable(node) ? node.isAsync() : false,
    isDefaultExport,
    isHook: isHookName(name),
    location: locationOf(node, filePath),
  }

  const description = getDescription(docNode ?? (Node.isJSDocable(node) ? node : undefined))
  if (description !== undefined) result.description = description

  return result
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Builds an {@link ExportedType} from an interface declaration.
 *
 * @internal
 */
export function fromInterface(
  declaration: InterfaceDeclaration,
  filePath: string,
): ExportedType {
  const result: ExportedType = {
    name: declaration.getName(),
    kind: 'interface',
    members: membersOfType(declaration.getType(), declaration),
    text: sanitizeTypeText(declaration.getText()),
    extends: declaration.getExtends().map((clause) => clause.getText()),
    isDefaultExport: declaration.isDefaultExport(),
    location: locationOf(declaration, filePath),
  }

  const description = getDescription(declaration)
  if (description !== undefined) result.description = description

  return result
}

/**
 * Builds an {@link ExportedType} from a type alias declaration.
 *
 * Members are populated only when the alias resolves to an object-like type;
 * unions and primitives carry their definition in `text` instead.
 *
 * @internal
 */
export function fromTypeAlias(
  declaration: TypeAliasDeclaration,
  filePath: string,
): ExportedType {
  const typeNode = declaration.getTypeNode()
  const isObjectLike =
    typeNode !== undefined &&
    (Node.isTypeLiteral(typeNode) || Node.isIntersectionTypeNode(typeNode))

  const result: ExportedType = {
    name: declaration.getName(),
    kind: 'type-alias',
    members: isObjectLike ? membersOfType(declaration.getType(), declaration) : [],
    text: sanitizeTypeText(typeNode?.getText() ?? declaration.getText()),
    extends: [],
    isDefaultExport: declaration.isDefaultExport(),
    location: locationOf(declaration, filePath),
  }

  const description = getDescription(declaration)
  if (description !== undefined) result.description = description

  return result
}

/**
 * Builds an {@link ExportedType} from an enum declaration.
 *
 * @internal
 */
export function fromEnum(declaration: EnumDeclaration, filePath: string): ExportedType {
  const members: TypeMember[] = declaration.getMembers().map((member) => {
    const value = member.getValue()
    const entry: TypeMember = {
      name: member.getName(),
      type: value === undefined ? 'number' : JSON.stringify(value),
      optional: false,
    }
    const memberDescription = getDescription(member)
    if (memberDescription !== undefined) entry.description = memberDescription
    return entry
  })

  const result: ExportedType = {
    name: declaration.getName(),
    kind: 'enum',
    members,
    text: sanitizeTypeText(declaration.getText()),
    extends: [],
    isDefaultExport: declaration.isDefaultExport(),
    location: locationOf(declaration, filePath),
  }

  const description = getDescription(declaration)
  if (description !== undefined) result.description = description

  return result
}

/**
 * Builds an {@link ExportedType} from a class declaration.
 *
 * @internal
 */
export function fromClass(declaration: ClassDeclaration, filePath: string): ExportedType {
  const members: TypeMember[] = []

  for (const property of declaration.getProperties()) {
    if (property.hasModifier(SyntaxKind.PrivateKeyword) || property.getName().startsWith('#')) {
      continue
    }
    const entry: TypeMember = {
      name: property.getName(),
      type: renderType(property.getTypeNode(), property),
      optional: property.hasQuestionToken(),
    }
    const propertyDescription = getDescription(property)
    if (propertyDescription !== undefined) entry.description = propertyDescription
    members.push(entry)
  }

  for (const method of declaration.getMethods()) {
    if (method.hasModifier(SyntaxKind.PrivateKeyword) || method.getName().startsWith('#')) {
      continue
    }
    const parameters = method
      .getParameters()
      .map((parameter) => `${parameter.getName()}: ${renderType(parameter.getTypeNode(), parameter)}`)
      .join(', ')

    const entry: TypeMember = {
      name: method.getName(),
      type: `(${parameters}) => ${renderReturnType(method)}`,
      optional: method.hasQuestionToken(),
    }
    const methodDescription = getDescription(method)
    if (methodDescription !== undefined) entry.description = methodDescription
    members.push(entry)
  }

  const extendsClause = declaration.getExtends()

  const result: ExportedType = {
    name: declaration.getName() ?? 'default',
    kind: 'class',
    members,
    text: `class ${declaration.getName() ?? 'default'}`,
    extends: [
      ...(extendsClause === undefined ? [] : [extendsClause.getText()]),
      ...declaration.getImplements().map((clause) => clause.getText()),
    ],
    isDefaultExport: declaration.isDefaultExport(),
    location: locationOf(declaration, filePath),
  }

  const description = getDescription(declaration)
  if (description !== undefined) result.description = description

  return result
}

/* -------------------------------------------------------------------------- */
/* Module references                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Collects the raw `import` statements of a source file.
 *
 * Specifiers are returned unresolved; {@link RepositoryResolver} attaches
 * resolution results afterwards.
 *
 * @internal
 */
export function collectImports(sourceFile: SourceFile): Array<Omit<ModuleReference, 'isExternal'>> {
  const references: Array<Omit<ModuleReference, 'isExternal'>> = []

  for (const declaration of sourceFile.getImportDeclarations()) {
    const names: string[] = []

    if (declaration.getDefaultImport() !== undefined) names.push('default')
    if (declaration.getNamespaceImport() !== undefined) names.push('*')
    for (const named of declaration.getNamedImports()) {
      names.push(named.getName())
    }

    references.push({
      moduleSpecifier: declaration.getModuleSpecifierValue(),
      names: dedupeSorted(names),
      isTypeOnly: declaration.isTypeOnly(),
    })
  }

  return references
}

/**
 * Collects the `export ... from '...'` re-export statements of a source file.
 *
 * Local `export { x }` statements without a module specifier are skipped: they
 * create no cross-file dependency.
 *
 * @internal
 */
export function collectReExports(
  sourceFile: SourceFile,
): Array<Omit<ModuleReference, 'isExternal'>> {
  const references: Array<Omit<ModuleReference, 'isExternal'>> = []

  for (const declaration of sourceFile.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue()
    if (specifier === undefined) continue

    const names: string[] = []
    if (declaration.isNamespaceExport()) names.push('*')
    for (const named of declaration.getNamedExports()) {
      names.push(named.getName())
    }

    references.push({
      moduleSpecifier: specifier,
      names: dedupeSorted(names.length > 0 ? names : ['*']),
      isTypeOnly: declaration.isTypeOnly(),
    })
  }

  return references
}

/**
 * De-duplicates and sorts a list of names for deterministic output.
 *
 * @internal
 */
export function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * Narrows an exported declaration list to the first entry, if present.
 *
 * @internal
 */
export function firstDeclaration(
  declarations: ExportedDeclarations[] | undefined,
): ExportedDeclarations | undefined {
  return declarations?.[0]
}

/**
 * Resolves the underlying function-like node of a variable initializer, so that
 * `export const useFoo = () => {}` is treated like a function declaration.
 *
 * @internal
 */
export function functionLikeInitializer(node: Node | undefined): Node | undefined {
  if (node === undefined) return undefined
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node

  // Unwrap wrappers such as `React.memo(...)` / `forwardRef(...)`.
  if (Node.isCallExpression(node)) {
    for (const argument of node.getArguments()) {
      const inner = functionLikeInitializer(argument)
      if (inner !== undefined) return inner
    }
  }

  if (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    return functionLikeInitializer(node.getExpression())
  }

  return undefined
}

/**
 * `true` when a function declaration is the default export of its file.
 *
 * @internal
 */
export function isDefaultExported(declaration: FunctionDeclaration | ClassDeclaration): boolean {
  try {
    return declaration.isDefaultExport()
  } catch {
    return false
  }
}
