import fs from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import { DEFAULT_EXCLUDE_PATTERNS } from '../types'
import { toAbsolutePosix, toPosix } from './paths'

/**
 * Result of walking a repository for source or token files.
 *
 * @internal
 */
export interface RepositoryScan {
  /** Absolute, POSIX-normalized repository root. */
  rootPath: string
  /** Absolute, POSIX-normalized paths of every matched file, sorted. */
  files: string[]
  /** Workspace package name to the absolute directory that declares it. */
  packageRoots: Map<string, string>
  /** Absolute package directory to the workspace package name it declares. */
  packageNameByDir: Map<string, string>
}

/**
 * Throws a descriptive error when `repoPath` is not a readable directory.
 *
 * Failing loudly here is deliberate: an unreadable repository root is a caller
 * bug, whereas a malformed *file inside* the repository is data and must only
 * produce a warning.
 *
 * @internal
 */
export function assertReadableDirectory(repoPath: string, functionName: string): string {
  if (typeof repoPath !== 'string' || repoPath.trim() === '') {
    throw new TypeError(`${functionName}: "repoPath" must be a non-empty string.`)
  }

  const absolute = path.resolve(repoPath)

  let stats: fs.Stats
  try {
    stats = fs.statSync(absolute)
  } catch {
    throw new Error(`${functionName}: repository path does not exist: ${absolute}`)
  }

  if (!stats.isDirectory()) {
    throw new Error(`${functionName}: repository path is not a directory: ${absolute}`)
  }

  return toPosix(absolute)
}

/**
 * Merges caller-supplied excludes with {@link DEFAULT_EXCLUDE_PATTERNS}.
 *
 * The defaults are always applied — callers can add exclusions but never remove
 * the guard rails that keep `node_modules` out of a scan.
 *
 * @internal
 */
export function resolveExcludePatterns(exclude: readonly string[] | undefined): string[] {
  return [...DEFAULT_EXCLUDE_PATTERNS, ...(exclude ?? [])]
}

/**
 * Walks `repoPath` for files matching `include`, and discovers workspace package
 * roots so that files can be attributed to the package that owns them.
 *
 * @internal
 */
export function scanRepository(
  repoPath: string,
  include: readonly string[],
  exclude: readonly string[] | undefined,
  maxFiles: number,
): RepositoryScan {
  const rootPath = toAbsolutePosix(repoPath)
  const ignore = resolveExcludePatterns(exclude)

  const files = fg
    .sync([...include], {
      cwd: rootPath,
      ignore,
      absolute: true,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
    })
    .map(toPosix)
    .sort()

  const { packageRoots, packageNameByDir } = discoverPackageRoots(rootPath)

  return {
    rootPath,
    files: files.slice(0, maxFiles),
    packageRoots,
    packageNameByDir,
  }
}

/**
 * Finds every `package.json` in the repository (excluding `node_modules`) and
 * maps package names to their directories.
 *
 * @internal
 */
export function discoverPackageRoots(rootPath: string): {
  packageRoots: Map<string, string>
  packageNameByDir: Map<string, string>
} {
  const packageRoots = new Map<string, string>()
  const packageNameByDir = new Map<string, string>()

  const manifests = fg.sync(['**/package.json'], {
    cwd: rootPath,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
  })

  for (const manifest of manifests) {
    const name = readPackageName(manifest)
    if (name === undefined) continue

    const dir = toPosix(path.dirname(manifest))
    packageNameByDir.set(dir, name)

    // First declaration wins, keeping the result stable when two packages share
    // a name (which is itself a repository bug, not something we should crash on).
    if (!packageRoots.has(name)) {
      packageRoots.set(name, dir)
    }
  }

  return { packageRoots, packageNameByDir }
}

/**
 * Reads the `name` field of a `package.json`, returning `undefined` when the
 * file is unreadable or malformed.
 *
 * @internal
 */
function readPackageName(manifestPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
      const name = (parsed as { name?: unknown }).name
      if (typeof name === 'string' && name.trim() !== '') return name
    }
  } catch {
    // A malformed package.json is data, not a caller bug: ignore it.
  }
  return undefined
}

/**
 * Returns the name of the closest ancestor package that owns `fileAbsPath`.
 *
 * @internal
 */
export function nearestPackageName(
  fileAbsPath: string,
  packageNameByDir: Map<string, string>,
  rootPath: string,
): string | undefined {
  let dir = toPosix(path.dirname(fileAbsPath))

  for (;;) {
    const name = packageNameByDir.get(dir)
    if (name !== undefined) return name
    if (dir === rootPath || dir === '/' || !dir.startsWith(rootPath)) return undefined

    const parent = toPosix(path.dirname(dir))
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Reads a UTF-8 file, returning `undefined` instead of throwing.
 *
 * @internal
 */
export function readFileSafe(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}
