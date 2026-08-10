/**
 * Publishes the package to npm with a provenance attestation.
 *
 * Why this exists instead of `changeset publish`:
 *
 * Changesets delegates the actual publish to the detected package manager, and
 * because this repository declares `packageManager: pnpm`, it runs
 * `pnpm publish`. pnpm supports only `--access`, `--tag` and `--no-git-checks`
 * — it has no provenance support and ignores `NPM_CONFIG_PROVENANCE`. The
 * publish therefore succeeds while silently producing an unattested tarball.
 *
 * `npm publish` does support `--provenance`, so the publish is driven directly
 * here. Versioning and changelog generation still belong to changesets.
 *
 * The script is idempotent: the release workflow runs on every push to main,
 * so it must do nothing when the current version is already on the registry.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const { name, version } = pkg

/** Reports back to the workflow so later steps can tag and cut a release. */
function setOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

async function isAlreadyPublished() {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}/${version}`
  const response = await fetch(url)

  if (response.status === 200) return true
  if (response.status === 404) return false

  // Anything else (rate limiting, an outage) is not a reliable "not published",
  // and republishing over an existing version would fail anyway.
  throw new Error(`Unexpected ${response.status} from the registry for ${name}@${version}`)
}

if (await isAlreadyPublished()) {
  console.log(`${name}@${version} is already on npm — nothing to publish.`)
  setOutput('published', 'false')
  setOutput('version', version)
  process.exit(0)
}

console.log(`Publishing ${name}@${version} with provenance …`)

execFileSync('npm', ['publish', '--provenance', '--access', 'public'], {
  cwd: root,
  stdio: 'inherit',
})

setOutput('published', 'true')
setOutput('version', version)
