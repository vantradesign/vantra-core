# @vantra-design/core

## 0.1.2

### Patch Changes

- 21135cf: Actually attach provenance attestations to published tarballs.

  The previous release enabled provenance in configuration only. Changesets delegates publishing to the detected package manager, and `pnpm publish` neither supports `--provenance` nor reads `NPM_CONFIG_PROVENANCE`, so the setting was silently ignored. Publishing now runs through `npm publish --provenance`, and releases can be verified with `npm audit signatures`.

## 0.1.1

### Patch Changes

- 24abd7e: Publish with npm provenance attestations.

  Released tarballs now carry a signed statement linking them to the exact commit and workflow run that produced them, which consumers can check with `npm audit signatures`. No runtime behaviour changes.

## 0.1.0

### Minor Changes

- a029fa9: Initial release of the shared primitives for the Vantra governance suite.

  - `parseComponents()` — extracts the public surface of Vue SFC, React and plain TypeScript modules, including props, exported functions/types/values, imports, re-exports and design-token references.
  - `buildComponentGraph()` — builds a serializable dependency graph with name/path/package indexes, cycle detection and reverse lookups (`getConsumersOf`, `getDependenciesOf`). Graphs round-trip losslessly through JSON.
  - `parseTokenSchema()` — normalizes DTCG, Style Dictionary and CSS custom-property tokens into one canonical schema with alias resolution and theme variants.
