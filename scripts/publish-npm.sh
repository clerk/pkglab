#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=""
OTP=""
PATCH_ONLY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    --otp) OTP="--otp $2"; shift 2 ;;
    --patch-only) PATCH_ONLY=true; shift ;;
    *) break ;;
  esac
done

BUMP="${1:-patch}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Bump version in root package.json (patch/minor/major)
cd "$PROJECT_ROOT"
npm version "$BUMP" --no-git-tag-version > /dev/null
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${PROJECT_ROOT}/package.json','utf8')).version)")

# Keep in sync with scripts/platforms.ts
PLATFORMS=("darwin-arm64" "darwin-x64" "linux-x64" "linux-arm64")

cd "$PROJECT_ROOT"

# Patch version into platform package.json files
for platform in "${PLATFORMS[@]}"; do
  file="npm/${platform}/package.json"
  echo "Patching version ${VERSION} into ${file}"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$file', 'utf8'));
    p.version = '$VERSION';
    fs.writeFileSync('$file', JSON.stringify(p, null, 2) + '\n');
  "
done

# Patch version into main package.json (version + optionalDependencies)
file="npm/pkglab/package.json"
echo "Patching version ${VERSION} into ${file} (version + optionalDependencies)"
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('$file', 'utf8'));
  p.version = '$VERSION';
  for (const k of Object.keys(p.optionalDependencies || {})) p.optionalDependencies[k] = '$VERSION';
  fs.writeFileSync('$file', JSON.stringify(p, null, 2) + '\n');
"

# Build binaries with new version baked in
echo "Building binaries..."
for platform in "${PLATFORMS[@]}"; do
  echo "Building pkglab-${platform}..."
  mkdir -p "npm/${platform}/bin"
  bun build --compile --target="bun-${platform}" --define "__PKGLAB_VERSION__=\"${VERSION}\"" --outfile "npm/${platform}/bin/pkglab" src/index.ts
done

# Commit version bump
git add package.json npm/*/package.json
git commit -m "chore(release): ${VERSION}"

if $PATCH_ONLY; then
  echo "Patched all packages to ${VERSION}"
  exit 0
fi

# Publish platform packages in parallel
PIDS=()
for platform in "${PLATFORMS[@]}"; do
  echo "Publishing pkglab-${platform}@${VERSION}..."
  npm publish "npm/${platform}/" --access public $DRY_RUN $OTP &
  PIDS+=($!)
done

FAILED=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || FAILED=$((FAILED + 1))
done

if [[ $FAILED -gt 0 ]]; then
  echo "ERROR: ${FAILED} platform package(s) failed to publish"
  exit 1
fi

# Publish main package last (depends on platform packages existing)
echo "Publishing pkglab@${VERSION}..."
npm publish "npm/pkglab/" --access public $DRY_RUN $OTP

echo "Successfully published all packages at version ${VERSION}${DRY_RUN:+ (dry run)}"
