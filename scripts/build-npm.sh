#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${ROOT}/package.json','utf8')).version)")
# Keep in sync with scripts/platforms.ts
TARGETS=("darwin-arm64" "darwin-x64" "linux-x64" "linux-arm64")

for target in "${TARGETS[@]}"; do
  echo "Building pkglab-${target}..."
  mkdir -p "${ROOT}/npm/${target}/bin"
  bun build --compile --target="bun-${target}" --define "__PKGLAB_VERSION__=\"${VERSION}\"" --outfile "${ROOT}/npm/${target}/bin/pkglab" "${ROOT}/src/index.ts"
done

echo "Done. Built ${#TARGETS[@]} binaries."
