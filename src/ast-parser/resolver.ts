import fs from 'node:fs'
import path from 'node:path'
import { toPosix } from '../internal/paths'

/**
 * Outcome of resolving one module specifier.
 *
 * @internal
 */
export interface ResolvedModule {
  /** Absolute POSIX path of the target file, when it lives inside the repository. */
  absolutePath?: string
  /** Workspace package the specifier points at, when it is a package import. */
  packageName?: string
  /**
   * `true` when the specifier points outside the repository (a real third-party
   * dependency). Unresolved *relative* specifiers are not external — they are
   * broken, and the graph reports them as warnings.
   */
  isExternal: boolean
}

/** Extensions appended to an extensionless specifier, in priority order. */
const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.vue', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/** Index files tried when a specifier resolves to a directory. */
const INDEX_BASENAMES = ['index.ts', 'index.tsx', 'index.vue', 'index.js', 'index.jsx']

/** Entry points tried when a bare workspace package specifier is imported. */
const PACKAGE_ENTRY_CANDIDATES = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.vue',
  'index.ts',
  'index.tsx',
  'src/index.js',
  'index.js',
]

/**
 * Resolves module specifiers against the *set of files that were actually
 * scanned*, rather than against the filesystem or the TypeScript resolver.
 *
 * This matters for two reasons: `.vue` files are invisible to the TypeScript
 * resolver, and we only ever want edges pointing at nodes that exist in the
 * graph.
 *
 * @internal
 */
export class RepositoryResolver {
  readonly #rootPath: string
  readonly #files: Set<string>
  readonly #packageRoots: Map<string, string>
  readonly #aliases: Array<[string, string]>
  readonly #cache = new Map<string, ResolvedModule>()

  constructor(
    rootPath: string,
    files: readonly string[],
    packageRoots: Map<string, string>,
    aliases: Record<string, string> = {},
  ) {
    this.#rootPath = rootPath
    this.#files = new Set(files)
    this.#packageRoots = packageRoots
    // Longest prefix first, so `@/components/` wins over `@/`.
    this.#aliases = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length)
  }

  /**
   * Resolves `specifier` as written inside `fromFileAbsPath`.
   */
  resolve(fromFileAbsPath: string, specifier: string): ResolvedModule {
    const cacheKey = `${fromFileAbsPath}\u0000${specifier}`
    const cached = this.#cache.get(cacheKey)
    if (cached !== undefined) return cached

    const result = this.#resolveUncached(fromFileAbsPath, specifier)
    this.#cache.set(cacheKey, result)
    return result
  }

  #resolveUncached(fromFileAbsPath: string, specifier: string): ResolvedModule {
    if (specifier === '') return { isExternal: true }

    // 1. Relative and absolute-path specifiers.
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = specifier.startsWith('/')
        ? toPosix(path.join(this.#rootPath, specifier))
        : toPosix(path.resolve(path.dirname(fromFileAbsPath), specifier))

      const hit = this.#tryCandidates(base)
      // A relative import that resolves to nothing is broken, not external.
      return hit !== undefined ? { absolutePath: hit, isExternal: false } : { isExternal: false }
    }

    // 2. Configured path aliases.
    for (const [prefix, target] of this.#aliases) {
      if (!specifier.startsWith(prefix)) continue
      const remainder = specifier.slice(prefix.length)
      const base = toPosix(path.join(this.#rootPath, target, remainder))
      const hit = this.#tryCandidates(base)
      if (hit !== undefined) return { absolutePath: hit, isExternal: false }
    }

    // 3. Workspace package specifiers (`@acme/ui`, `@acme/ui/Button`).
    const packageMatch = this.#matchPackage(specifier)
    if (packageMatch !== undefined) {
      const { packageName, packageDir, subpath } = packageMatch

      if (subpath === '') {
        for (const entry of PACKAGE_ENTRY_CANDIDATES) {
          const candidate = toPosix(path.join(packageDir, entry))
          if (this.#files.has(candidate)) {
            return { absolutePath: candidate, packageName, isExternal: false }
          }
        }
        const fromManifest = this.#resolveFromManifest(packageDir)
        if (fromManifest !== undefined) {
          return { absolutePath: fromManifest, packageName, isExternal: false }
        }
        // The package exists in this repo even if we could not pin an entry file.
        return { packageName, isExternal: false }
      }

      const hit = this.#tryCandidates(toPosix(path.join(packageDir, subpath)))
      if (hit !== undefined) return { absolutePath: hit, packageName, isExternal: false }

      const srcHit = this.#tryCandidates(toPosix(path.join(packageDir, 'src', subpath)))
      if (srcHit !== undefined) return { absolutePath: srcHit, packageName, isExternal: false }

      return { packageName, isExternal: false }
    }

    // 4. Everything else is a genuine third-party dependency.
    return { isExternal: true }
  }

  /**
   * Finds the workspace package a bare specifier belongs to, preferring the
   * longest matching package name (`@acme/ui-icons` over `@acme/ui`).
   */
  #matchPackage(
    specifier: string,
  ): { packageName: string; packageDir: string; subpath: string } | undefined {
    let best: { packageName: string; packageDir: string; subpath: string } | undefined

    for (const [packageName, packageDir] of this.#packageRoots) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue
      if (best !== undefined && packageName.length <= best.packageName.length) continue

      best = {
        packageName,
        packageDir,
        subpath: specifier === packageName ? '' : specifier.slice(packageName.length + 1),
      }
    }

    return best
  }

  /**
   * Tries the source-file entry points declared by a package manifest.
   */
  #resolveFromManifest(packageDir: string): string | undefined {
    const manifestPath = toPosix(path.join(packageDir, 'package.json'))
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      return undefined
    }

    for (const field of ['source', 'module', 'main', 'types'] as const) {
      const value = manifest[field]
      if (typeof value !== 'string') continue
      const hit = this.#tryCandidates(toPosix(path.join(packageDir, value)))
      if (hit !== undefined) return hit
    }

    return undefined
  }

  /**
   * Expands one base path into the candidate files TypeScript/bundlers would try.
   */
  #tryCandidates(base: string): string | undefined {
    if (this.#files.has(base)) return base

    // `./Button.js` in ESM source usually means `./Button.ts` on disk.
    const jsLike = /\.(js|jsx|mjs|cjs)$/.exec(base)
    if (jsLike !== null) {
      const withoutExtension = base.slice(0, -jsLike[0].length)
      for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.vue']) {
        const candidate = `${withoutExtension}${extension}`
        if (this.#files.has(candidate)) return candidate
      }
    }

    for (const extension of CANDIDATE_EXTENSIONS) {
      const candidate = `${base}${extension}`
      if (this.#files.has(candidate)) return candidate
    }

    for (const basename of INDEX_BASENAMES) {
      const candidate = toPosix(path.join(base, basename))
      if (this.#files.has(candidate)) return candidate
    }

    return undefined
  }
}
