// Syncs the root package.json version into all npm platform package.json files.
// Run after `changeset version` bumps the root version.

import { PLATFORMS } from './platforms';

const ROOT = import.meta.dir + '/..';

const rootPkg = await Bun.file(`${ROOT}/package.json`).json();
const version = rootPkg.version;

console.log(`Syncing version ${version} to npm packages...`);

// Update platform packages
for (const platform of PLATFORMS) {
  const path = `${ROOT}/npm/${platform}/package.json`;
  const pkg = await Bun.file(path).json();
  pkg.version = version;
  await Bun.write(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  Updated npm/${platform}/package.json`);
}

// Update main package (version + optionalDependencies)
const mainPath = `${ROOT}/npm/pkglab/package.json`;
const mainPkg = await Bun.file(mainPath).json();
mainPkg.version = version;
for (const key of Object.keys(mainPkg.optionalDependencies || {})) {
  mainPkg.optionalDependencies[key] = version;
}
await Bun.write(mainPath, JSON.stringify(mainPkg, null, 2) + '\n');
console.log(`  Updated npm/pkglab/package.json (version + optionalDependencies)`);

console.log(`Done. All packages synced to ${version}.`);
