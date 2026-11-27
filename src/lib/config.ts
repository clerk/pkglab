import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { pkglabConfig } from '../types';

import { log } from './log';
import { paths } from './paths';

const CURRENT_CONFIG_VERSION = 1;

const DEFAULT_CONFIG: pkglabConfig = {
  version: CURRENT_CONFIG_VERSION,
  port: 16180,
  prune_keep: 3,
};

export async function ensurepkglabDirs(): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  // mode only applies on creation; tighten dirs made by older versions too
  await chmod(paths.home, 0o700);
  await mkdir(paths.reposDir, { recursive: true });
  await mkdir(paths.listenersDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });

  // Migrate legacy ~/.pkglab/verdaccio/ to ~/.pkglab/registry/
  const legacyDir = join(paths.home, 'verdaccio');
  try {
    const legacyStat = await stat(legacyDir);
    if (legacyStat.isDirectory()) {
      await rm(paths.registryDir, { recursive: true, force: true });
      await rename(legacyDir, paths.registryDir);
    }
  } catch {
    // Legacy dir doesn't exist, nothing to migrate
  }

  await mkdir(paths.registryDir, { recursive: true });
}

export async function loadConfig(): Promise<pkglabConfig> {
  // Check for old YAML config (pre-JSON migration)
  const oldConfigPath = join(paths.home, 'config.yaml');
  const oldConfigFile = Bun.file(oldConfigPath);
  if (await oldConfigFile.exists()) {
    log.error('Incompatible pkglab data format detected (config.yaml is no longer supported).');
    log.error('Run: pkglab reset --hard');
    process.exit(1);
  }

  const file = Bun.file(paths.config);
  if (!(await file.exists())) {
    await Bun.write(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return { ...DEFAULT_CONFIG };
  }

  const text = await file.text();
  const parsed = JSON.parse(text) as Partial<pkglabConfig>;

  if (!parsed.version || parsed.version < CURRENT_CONFIG_VERSION) {
    log.error('Incompatible pkglab config version.');
    log.error('Run: pkglab reset --hard');
    process.exit(1);
  }

  return { ...DEFAULT_CONFIG, ...parsed };
}
