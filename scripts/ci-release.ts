// CI release script: cross-compiles binaries, publishes all packages to npm,
// and creates a git tag.

import { mkdirSync } from 'node:fs';

const ROOT = import.meta.dir + '/..';

const rootPkg = await Bun.file(`${ROOT}/package.json`).json();
const version = rootPkg.version;

console.log(`Publishing pkglab@${version}`);

// Check if this version is already published
const checkProc = Bun.spawn(['npm', 'view', `pkglab@${version}`, 'version'], {
  stdout: 'pipe',
  stderr: 'pipe',
});
const checkOutput = (await new Response(checkProc.stdout).text()).trim();
await checkProc.exited;
if (checkOutput === version) {
  console.log(`pkglab@${version} is already published, nothing to do.`);
  process.exit(0);
}

import { PLATFORMS as platforms } from './platforms';

// Copy repo README into main package, write redirect READMEs for platform packages
const repoReadme = await Bun.file(`${ROOT}/README.md`).text();
await Bun.write(`${ROOT}/npm/pkglab/README.md`, repoReadme);
for (const platform of platforms) {
  await Bun.write(
    `${ROOT}/npm/${platform}/README.md`,
    `# pkglab-${platform}\n\nPlatform binary for [pkglab](https://www.npmjs.com/package/pkglab). See the main package for documentation.\n`,
  );
}

// Cross-compile binaries
console.log('\nBuilding binaries...');
for (const platform of platforms) {
  mkdirSync(`${ROOT}/npm/${platform}/bin`, { recursive: true });
  const proc = Bun.spawn(
    [
      'bun',
      'build',
      '--compile',
      `--target=bun-${platform}`,
      `--define`,
      `__PKGLAB_VERSION__="${version}"`,
      `--outfile`,
      `${ROOT}/npm/${platform}/bin/pkglab`,
      `${ROOT}/src/index.ts`,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`ERROR: Failed to build pkglab-${platform}`);
    process.exit(1);
  }
  console.log(`  Built pkglab-${platform}`);
}

// Publish platform packages in parallel
console.log('\nPublishing platform packages...');
const platformResults = await Promise.all(
  platforms.map(async platform => {
    console.log(`  Publishing pkglab-${platform}@${version}...`);
    const proc = Bun.spawn(['npm', 'publish', `${ROOT}/npm/${platform}/`, '--access', 'public'], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;
    return { platform, exitCode };
  }),
);

const failures = platformResults.filter(r => r.exitCode !== 0);
if (failures.length > 0) {
  console.error(`\nERROR: ${failures.length} platform package(s) failed to publish:`);
  for (const f of failures) {
    console.error(`  - pkglab-${f.platform}`);
  }
  process.exit(1);
}

// Publish main package last (depends on platform packages being available)
console.log(`\nPublishing pkglab@${version}...`);
const mainProc = Bun.spawn(['npm', 'publish', `${ROOT}/npm/pkglab/`, '--access', 'public'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
const mainExitCode = await mainProc.exited;
if (mainExitCode !== 0) {
  console.error('ERROR: Failed to publish main pkglab package');
  process.exit(1);
}

// Create git tag
console.log(`\nCreating git tag v${version}...`);
const tagProc = Bun.spawn(['git', 'tag', `v${version}`], {
  stdout: 'inherit',
  stderr: 'inherit',
});
const tagExitCode = await tagProc.exited;
if (tagExitCode !== 0) {
  console.error('ERROR: Failed to create git tag');
  process.exit(1);
}

console.log(`\nSuccessfully published all packages at version ${version}`);
