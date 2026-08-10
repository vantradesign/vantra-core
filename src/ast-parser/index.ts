import path from 'node:path'
import {
  Node,
  Project,
  ScriptKind,
  ts,
  VariableDeclarationKind,
  type SourceFile,
  type TypeNode,
} from 'ts-morph'
import type {
  ExportedFunction,
  ExportedType,
  ExportedValue,
  ModuleReference,
  ParseComponentsOptions,
  ParsedComponent,
  PropDefinition,
  SourceLocation,
} from '../types'
import {
  basenameWithoutExtension,
  extensionOf,
  toPascalCase,
  toRepoRelative,
} from '../internal/paths'
import {
  assertReadableDirectory,
  nearestPackageName,
  readFileSafe,
  scanRepository,
} from '../internal/scan'
import { RepositoryResolver } from './resolver'
import { extractTokenReferences } from './token-references'
import { extractReactProps, isReactClassComponent, isReactComponent } from './react'
import {
  extractVueComponentName,
  extractVueDescription,
  extractVueProps,
  extractVueScript,
} from './vue'
import {
  collectImports,
  collectReExports,
  fromClass,
  fromEnum,
  fromInterface,
  fromTypeAlias,
  functionLikeInitializer,
  getDescription,
  locationOf,
  renderType,
  toExportedFunction,
} from './ts-utils'

/** Default glob patterns for source discovery. */
const DEFAULT_INCLUDE = ['**/*.ts', '**/*.tsx', '**/*.vue', '**/*.js', '**/*.jsx']

/** Default guard rail on repository size. */
const DEFAULT_MAX_FILES = 5000

/**
 * A file that has been loaded into the ts-morph project and is ready to parse.
 */
interface LoadedFile {
  /** Absolute POSIX path of the file on disk. */
  absolutePath: string
  /** Repository-relative POSIX path. */
  relativePath: string
  /** The ts-morph source file (virtual for `.vue`). */
  sourceFile: SourceFile
  /** Raw file contents, used for token-reference extraction. */
  rawText: string
  /** `true` when the file is a Vue SFC. */
  isVue: boolean
  /**
   * Line offset between the ts-morph source file and the real file, non-zero
   * for Vue SFCs whose script block does not start on line 1.
   */
  lineOffset: number
  /** Owning workspace package, when known. */
  packageName: string | undefined
}

/**
 * An exported binding that might be a component.
 */
interface ComponentCandidate {
  name: string
  /** The function-like node, when the binding resolves to one. */
  functionNode: Node | undefined
  /** The declaration used for location and documentation. */
  declarationNode: Node
  /** Explicit type annotation, e.g. `React.FC<ButtonProps>`. */
  typeNode: TypeNode | undefined
  isDefaultExport: boolean
}

/**
 * Parses every component and module in a repository and returns their public
 * API surface.
 *
 * Three source layouts are supported: Vue SFC component libraries, React TSX
 * component libraries, and plain TypeScript export modules (utility and token
 * packages). Monorepos are handled natively — files are attributed to the
 * nearest `package.json`, and imports between workspace packages are resolved.
 *
 * Parsing never throws on malformed *source*: an unparseable file is skipped so
 * that one bad component cannot fail a whole-repository analysis. It does throw
 * when `repoPath` itself is unreadable, since that is a caller error.
 *
 * @param repoPath - Absolute or relative path to the repository root.
 * @param options - Optional include/exclude globs, path aliases and limits.
 * @returns One entry per exported component, plus one `module` entry per file
 *          that exports no component. Sorted by `id` for deterministic output.
 *
 * @example
 * ```ts
 * import { parseComponents } from '@vantra-design/core'
 *
 * const components = parseComponents('./packages/ui', {
 *   include: ['src/**\/*.vue'],
 * })
 *
 * for (const component of components) {
 *   console.log(component.name, component.props.map((prop) => prop.name))
 * }
 * ```
 *
 * @public
 */
export function parseComponents(
  repoPath: string,
  options: ParseComponentsOptions = {},
): ParsedComponent[] {
  const rootPath = assertReadableDirectory(repoPath, 'parseComponents')

  const scan = scanRepository(
    rootPath,
    options.include ?? DEFAULT_INCLUDE,
    options.exclude,
    options.maxFiles ?? DEFAULT_MAX_FILES,
  )

  if (scan.files.length === 0) return []

  const project = createProject()
  const loaded = loadFiles(project, scan.files, scan.rootPath, scan.packageNameByDir)

  const resolver = new RepositoryResolver(
    scan.rootPath,
    scan.files,
    scan.packageRoots,
    options.aliases ?? {},
  )

  const components: ParsedComponent[] = []
  for (const file of loaded) {
    try {
      components.push(...parseLoadedFile(file, resolver, scan.rootPath))
    } catch {
      // A file that defeats the parser is skipped rather than fatal: governance
      // tooling must still report on the other 99% of the repository.
    }
  }

  return components.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Creates a ts-morph project configured for mixed Vue/React/TS repositories.
 */
function createProject(): Project {
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      allowNonTsExtensions: true,
      resolveJsonModule: true,
    },
  })
}

/**
 * Loads every scanned file into the project, translating Vue SFCs into virtual
 * TypeScript files so the same AST machinery works across all three layouts.
 */
function loadFiles(
  project: Project,
  files: readonly string[],
  rootPath: string,
  packageNameByDir: Map<string, string>,
): LoadedFile[] {
  const loaded: LoadedFile[] = []

  for (const absolutePath of files) {
    const rawText = readFileSafe(absolutePath)
    if (rawText === undefined) continue

    const relativePath = toRepoRelative(rootPath, absolutePath)
    const packageName = nearestPackageName(absolutePath, packageNameByDir, rootPath)
    const extension = extensionOf(absolutePath)

    try {
      if (extension === 'vue') {
        const script = extractVueScript(rawText, absolutePath)
        if (script.failed) continue

        const sourceFile = project.createSourceFile(
          `${absolutePath}.${script.isJsx ? 'tsx' : 'ts'}`,
          script.code,
          { overwrite: true, scriptKind: script.isJsx ? ScriptKind.TSX : ScriptKind.TS },
        )

        loaded.push({
          absolutePath,
          relativePath,
          sourceFile,
          rawText,
          isVue: true,
          lineOffset: vueScriptLineOffset(rawText),
          packageName,
        })
        continue
      }

      loaded.push({
        absolutePath,
        relativePath,
        sourceFile: project.addSourceFileAtPath(absolutePath),
        rawText,
        isVue: false,
        lineOffset: 0,
        packageName,
      })
    } catch {
      // Unreadable or syntactically hopeless file: skip it.
    }
  }

  return loaded
}

/**
 * Number of lines preceding the first `<script>` block of an SFC, so that
 * reported line numbers point into the `.vue` file rather than the extracted
 * script.
 *
 * When a component has both `<script>` and `<script setup>`, only the first
 * block's offset is accurate; declarations in the second block will be reported
 * relative to it.
 */
function vueScriptLineOffset(rawText: string): number {
  const match = /<script\b[^>]*>/.exec(rawText)
  if (match === null) return 0

  // Script content starts on the line *after* the opening tag, so the offset is
  // the tag's own 1-based line number: script line 1 maps to tagLine + 1.
  return rawText.slice(0, match.index + match[0].length).split('\n').length
}

/**
 * Parses one loaded file into its component/module entries.
 */
function parseLoadedFile(
  file: LoadedFile,
  resolver: RepositoryResolver,
  rootPath: string,
): ParsedComponent[] {
  const { sourceFile, relativePath } = file

  const imports = resolveReferences(collectImports(sourceFile), file, resolver, rootPath)
  const reExports = resolveReferences(collectReExports(sourceFile), file, resolver, rootPath)
  const tokenReferences = extractTokenReferences(file.rawText)

  const candidates = collectComponentCandidates(sourceFile, file)
  const componentNodes = new Set(candidates.map((candidate) => candidate.declarationNode))

  const functions = collectExportedFunctions(sourceFile, relativePath, componentNodes)
  const types = collectExportedTypes(sourceFile, relativePath, componentNodes)
  const values = collectExportedValues(sourceFile, relativePath, componentNodes)

  const shared = {
    packageName: file.packageName,
    functions,
    types,
    values,
    imports,
    reExports,
    tokenReferences,
  }

  if (file.isVue) {
    const name =
      extractVueComponentName(sourceFile) ?? deriveComponentNameFromPath(file.absolutePath)
    const description = extractVueDescription(sourceFile)

    return [
      withLineOffset(
        buildComponent({
          ...shared,
          name,
          kind: 'vue-sfc',
          filePath: relativePath,
          isDefaultExport: true,
          props: extractVueProps(sourceFile),
          description,
          location: { filePath: relativePath, line: 1, column: 1 },
        }),
        file.lineOffset,
      ),
    ]
  }

  const reactCandidates = candidates.filter((candidate) =>
    isReactComponent(
      candidate.name,
      candidate.functionNode ?? candidate.declarationNode,
      candidate.typeNode,
    ),
  )

  if (reactCandidates.length === 0) {
    return [
      buildComponent({
        ...shared,
        name: basenameWithoutExtension(file.absolutePath),
        kind: 'module',
        filePath: relativePath,
        isDefaultExport: false,
        props: [],
        location: { filePath: relativePath, line: 1, column: 1 },
      }),
    ]
  }

  return reactCandidates.map((candidate) => {
    const props: PropDefinition[] =
      candidate.functionNode === undefined
        ? []
        : extractReactProps(candidate.name, candidate.functionNode, sourceFile, candidate.typeNode)

    const description = Node.isJSDocable(candidate.declarationNode)
      ? getDescription(candidate.declarationNode)
      : undefined

    return buildComponent({
      ...shared,
      name: candidate.name,
      kind: 'react',
      filePath: relativePath,
      isDefaultExport: candidate.isDefaultExport,
      props,
      description,
      location: locationOf(candidate.declarationNode, relativePath),
    })
  })
}

/**
 * Assembles a {@link ParsedComponent}, deriving its stable id.
 */
function buildComponent(input: {
  name: string
  kind: ParsedComponent['kind']
  filePath: string
  packageName: string | undefined
  isDefaultExport: boolean
  props: PropDefinition[]
  functions: ExportedFunction[]
  types: ExportedType[]
  values: ExportedValue[]
  imports: ModuleReference[]
  reExports: ModuleReference[]
  tokenReferences: string[]
  description?: string | undefined
  location: SourceLocation
}): ParsedComponent {
  const component: ParsedComponent = {
    id: `${input.filePath}#${input.name}`,
    name: input.name,
    kind: input.kind,
    filePath: input.filePath,
    isDefaultExport: input.isDefaultExport,
    props: input.props,
    functions: input.functions,
    types: input.types,
    values: input.values,
    imports: input.imports,
    reExports: input.reExports,
    tokenReferences: input.tokenReferences,
    location: input.location,
  }

  if (input.packageName !== undefined) component.packageName = input.packageName
  if (input.description !== undefined) component.description = input.description

  return component
}

/**
 * Shifts every reported line number by the SFC script-block offset.
 */
function withLineOffset(component: ParsedComponent, offset: number): ParsedComponent {
  if (offset === 0) return component

  const shift = (location: SourceLocation): SourceLocation => ({
    ...location,
    line: location.line + offset,
  })

  return {
    ...component,
    functions: component.functions.map((fn) => ({ ...fn, location: shift(fn.location) })),
    types: component.types.map((type) => ({ ...type, location: shift(type.location) })),
    values: component.values.map((value) => ({ ...value, location: shift(value.location) })),
    location: shift(component.location),
  }
}

/**
 * Derives a component name from its filename, falling back to the directory
 * name for `index` files (`Button/index.vue` → `Button`).
 */
function deriveComponentNameFromPath(absolutePath: string): string {
  const base = basenameWithoutExtension(absolutePath)
  if (base.toLowerCase() !== 'index') return toPascalCase(base)

  const parent = path.basename(path.dirname(absolutePath))
  return toPascalCase(parent === '' ? base : parent)
}

/**
 * Attaches resolution results to raw module references.
 */
function resolveReferences(
  references: Array<Omit<ModuleReference, 'isExternal'>>,
  file: LoadedFile,
  resolver: RepositoryResolver,
  rootPath: string,
): ModuleReference[] {
  return references.map((reference) => {
    const resolved = resolver.resolve(file.absolutePath, reference.moduleSpecifier)

    const result: ModuleReference = {
      moduleSpecifier: reference.moduleSpecifier,
      names: reference.names,
      isTypeOnly: reference.isTypeOnly,
      isExternal: resolved.isExternal,
    }

    if (resolved.absolutePath !== undefined) {
      result.resolvedPath = toRepoRelative(rootPath, resolved.absolutePath)
    }
    if (resolved.packageName !== undefined) {
      result.resolvedPackage = resolved.packageName
    }

    return result
  })
}

/* -------------------------------------------------------------------------- */
/* Export collection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Collects every exported binding that could be a component.
 */
function collectComponentCandidates(
  sourceFile: SourceFile,
  file: LoadedFile,
): ComponentCandidate[] {
  const candidates: ComponentCandidate[] = []

  for (const declaration of sourceFile.getFunctions()) {
    if (!declaration.isExported()) continue
    const name = declaration.getName() ?? deriveComponentNameFromPath(file.absolutePath)

    candidates.push({
      name,
      functionNode: declaration,
      declarationNode: declaration,
      typeNode: undefined,
      isDefaultExport: declaration.isDefaultExport(),
    })
  }

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue

    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer()

      candidates.push({
        name: declaration.getName(),
        functionNode: functionLikeInitializer(initializer),
        declarationNode: statement,
        typeNode: declaration.getTypeNode(),
        isDefaultExport: false,
      })
    }
  }

  for (const declaration of sourceFile.getClasses()) {
    if (!declaration.isExported()) continue
    if (!isReactClassComponent(declaration)) continue

    const name = declaration.getName() ?? deriveComponentNameFromPath(file.absolutePath)

    candidates.push({
      name,
      functionNode: declaration,
      declarationNode: declaration,
      typeNode: undefined,
      isDefaultExport: declaration.isDefaultExport(),
    })
  }

  markDefaultExport(sourceFile, candidates, file)

  return candidates
}

/**
 * Resolves `export default X` / `export default memo(X)` onto an existing
 * candidate, or registers an anonymous default-exported component.
 */
function markDefaultExport(
  sourceFile: SourceFile,
  candidates: ComponentCandidate[],
  file: LoadedFile,
): void {
  const assignment = sourceFile.getExportAssignment(
    (candidate) => !candidate.isExportEquals(),
  )
  if (assignment === undefined) return

  const expression = assignment.getExpression()
  const identifier = findInnerIdentifier(expression)

  if (identifier !== undefined) {
    const match = candidates.find((candidate) => candidate.name === identifier)
    if (match !== undefined) {
      match.isDefaultExport = true
      return
    }
  }

  const functionNode = functionLikeInitializer(expression)
  if (functionNode === undefined) return

  candidates.push({
    name: identifier ?? deriveComponentNameFromPath(file.absolutePath),
    functionNode,
    declarationNode: assignment,
    typeNode: undefined,
    isDefaultExport: true,
  })
}

/**
 * Digs the referenced identifier out of `X`, `memo(X)`, `forwardRef(X)`, etc.
 */
function findInnerIdentifier(node: Node): string | undefined {
  if (Node.isIdentifier(node)) return node.getText()

  if (Node.isCallExpression(node)) {
    for (const argument of node.getArguments()) {
      const inner = findInnerIdentifier(argument)
      if (inner !== undefined) return inner
    }
  }

  if (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    return findInnerIdentifier(node.getExpression())
  }

  return undefined
}

/**
 * Collects exported functions, hooks and composables that are not components.
 */
function collectExportedFunctions(
  sourceFile: SourceFile,
  filePath: string,
  componentNodes: ReadonlySet<Node>,
): ExportedFunction[] {
  const functions: ExportedFunction[] = []

  for (const declaration of sourceFile.getFunctions()) {
    if (!declaration.isExported()) continue

    const name = declaration.getName()
    if (name === undefined) continue
    if (isReactComponent(name, declaration)) continue

    const fn = toExportedFunction(name, declaration, filePath, declaration.isDefaultExport())
    if (fn !== undefined) functions.push(fn)
  }

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue
    if (componentNodes.has(statement) && isComponentStatement(statement)) continue

    for (const declaration of statement.getDeclarations()) {
      const name = declaration.getName()
      const functionNode = functionLikeInitializer(declaration.getInitializer())
      if (functionNode === undefined) continue
      if (isReactComponent(name, functionNode, declaration.getTypeNode())) continue

      const fn = toExportedFunction(name, functionNode, filePath, false, statement)
      if (fn !== undefined) functions.push(fn)
    }
  }

  return functions
}

/**
 * `true` when every declaration in the statement is a React component.
 */
function isComponentStatement(statement: Node): boolean {
  if (!Node.isVariableStatement(statement)) return false

  return statement.getDeclarations().every((declaration) => {
    const functionNode = functionLikeInitializer(declaration.getInitializer())
    if (functionNode === undefined) return false
    return isReactComponent(declaration.getName(), functionNode, declaration.getTypeNode())
  })
}

/**
 * Collects exported interfaces, type aliases, enums and classes.
 */
function collectExportedTypes(
  sourceFile: SourceFile,
  filePath: string,
  componentNodes: ReadonlySet<Node>,
): ExportedType[] {
  const types: ExportedType[] = []

  for (const declaration of sourceFile.getInterfaces()) {
    if (declaration.isExported()) types.push(fromInterface(declaration, filePath))
  }
  for (const declaration of sourceFile.getTypeAliases()) {
    if (declaration.isExported()) types.push(fromTypeAlias(declaration, filePath))
  }
  for (const declaration of sourceFile.getEnums()) {
    if (declaration.isExported()) types.push(fromEnum(declaration, filePath))
  }
  for (const declaration of sourceFile.getClasses()) {
    // A class component is already reported as a component; listing it again as
    // an exported type would double-count it.
    if (componentNodes.has(declaration)) continue
    if (declaration.isExported()) types.push(fromClass(declaration, filePath))
  }

  return types
}

/**
 * Collects exported non-function values.
 */
function collectExportedValues(
  sourceFile: SourceFile,
  filePath: string,
  componentNodes: ReadonlySet<Node>,
): ExportedValue[] {
  const values: ExportedValue[] = []

  for (const statement of sourceFile.getVariableStatements()) {
    if (!statement.isExported()) continue

    const isConst = statement.getDeclarationKind() === VariableDeclarationKind.Const

    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer()
      if (functionLikeInitializer(initializer) !== undefined) continue

      const name = declaration.getName()
      if (componentNodes.has(statement) && isReactComponent(name, declaration)) continue

      const value: ExportedValue = {
        name,
        type: renderType(declaration.getTypeNode(), declaration),
        isConst,
        isDefaultExport: false,
        location: locationOf(declaration, filePath),
      }

      if (initializer !== undefined && isSimpleLiteral(initializer)) {
        value.literalValue = initializer.getText()
      }

      const description = getDescription(statement)
      if (description !== undefined) value.description = description

      values.push(value)
    }
  }

  return values
}

/**
 * `true` for string/number/boolean literals, which are cheap enough to persist.
 */
function isSimpleLiteral(node: Node): boolean {
  return (
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  )
}
