// Unit tests (bun test) get a throwaway pkglab home so they never touch the real ~/.pkglab.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pkglab-unit-home-'));
process.env.PKGLAB_HOME = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
