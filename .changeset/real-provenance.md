---
'@vantra-design/core': patch
---

Actually attach provenance attestations to published tarballs.

The previous release enabled provenance in configuration only. Changesets delegates publishing to the detected package manager, and `pnpm publish` neither supports `--provenance` nor reads `NPM_CONFIG_PROVENANCE`, so the setting was silently ignored. Publishing now runs through `npm publish --provenance`, and releases can be verified with `npm audit signatures`.
