#!/bin/sh
# Runtime-only license tripwire. The allowlist lives here (not in a package.json
# script) because knip's script parser treats the ';' separators in --onlyAllow
# as shell command separators and false-flags each license id as a binary.
# license-checker-rseidelsohn is run via bunx, so it adds no devDependency.
exec bunx license-checker-rseidelsohn@5.0.1 \
  --production \
  --onlyAllow 'MIT;ISC;Apache-2.0;BSD-2-Clause;BSD-3-Clause;0BSD;BlueOak-1.0.0;CC0-1.0;Python-2.0' \
  --excludePrivatePackages
