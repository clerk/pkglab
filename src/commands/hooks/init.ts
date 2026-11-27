import { defineCommand } from 'citty';
import { resolve } from 'node:path';

import { trustHooks } from '../../lib/hooks';
import { log } from '../../lib/log';

const PAYLOAD_DTS = `export interface PkglabHookPayload {
  schemaVersion: 1;
  event: 'add' | 'restore' | 'update';
  phase: 'pre' | 'post' | 'error';
  packages: Array<{ name: string; version: string; previous?: string }>;
  tag: string | null;
  repoPath: string;
  registryUrl: string;
  packageManager: string;
  error: { stage: string; message: string; failedHook: string | null } | null;
}
`;

const HOOK_STUBS: Record<string, string> = {
  'pre-add.ts': `// .pkglab/hooks/pre-add.ts
// Runs before \`pkglab add\` installs packages in this repo.
// Return a non-zero exit code to abort the add operation.
//
// import type { PkglabHookPayload } from './payload';
// const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
//
// Example: verify a local API server is running before allowing add
// const res = await fetch('http://localhost:3100/health').catch(() => null);
// if (!res?.ok) {
//   console.error('Local API server is not running. Start it first.');
//   process.exit(1);
// }
`,

  'post-add.ts': `// .pkglab/hooks/post-add.ts
// Runs after \`pkglab add\` installs packages in this repo.
//
// import type { PkglabHookPayload } from './payload';
// const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
//
// Example: set environment variables for local development
// const envFile = Bun.file('.env.local');
// await Bun.write(envFile, 'MY_VAR=local_value\\n');
`,

  'pre-restore.ts': `// .pkglab/hooks/pre-restore.ts
// Runs before \`pkglab restore\` reverts packages in this repo.
// Return a non-zero exit code to abort the restore operation.
//
// import type { PkglabHookPayload } from './payload';
// const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
//
// Example: confirm no uncommitted changes before restoring
// const result = Bun.spawnSync(['git', 'status', '--porcelain']);
// if (result.stdout.toString().trim()) {
//   console.error('Uncommitted changes detected. Commit or stash first.');
//   process.exit(1);
// }
`,

  'post-restore.ts': `// .pkglab/hooks/post-restore.ts
// Runs after \`pkglab restore\` reverts packages in this repo.
//
// import type { PkglabHookPayload } from './payload';
// const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
//
// Example: remove local environment overrides after restoring
// const envPath = '.env.local';
// const file = Bun.file(envPath);
// if (await file.exists()) {
//   const text = await file.text();
//   const cleaned = text.split('\\n').filter(l => !l.startsWith('MY_VAR=')).join('\\n');
//   await Bun.write(envPath, cleaned);
// }
`,

  'pre-update.ts': `// .pkglab/hooks/pre-update.ts
// Runs before \`pkglab pub\` auto-updates this repo with new package versions.
// Return a non-zero exit code to skip this repo (other repos continue).
//
// import type { PkglabHookPayload } from './payload';
// const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
//
// Example: skip auto-update if a dev server is running
// const lockFile = Bun.file('/tmp/dev-server.lock');
// if (await lockFile.exists()) {
//   console.error('Dev server is running. Skipping auto-update.');
//   process.exit(1);
// }
`,

  'post-update.ts': `// .pkglab/hooks/post-update.ts
// Runs after \`pkglab pub\` auto-updates this repo with new package versions.
//
// import type { PkglabHookPayload } from './payload';
// const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
//
// Example: restart the dev server after packages are updated
// console.log(\`Updated \${payload.packages.length} packages, restarting dev server...\`);
// Bun.spawn(['bun', 'run', 'dev:restart'], { cwd: payload.repoPath });
`,

  'on-error.ts': `// .pkglab/hooks/on-error.ts
// Runs when an operation fails (internal error or pre-hook abort).
// Best-effort, non-recursive (if this hook fails, the error is swallowed).
//
// import type { PkglabHookPayload } from './payload';
// const payload: PkglabHookPayload = JSON.parse(process.argv[2]);
//
// Example: log errors to a file for debugging
// const entry = \`[\${new Date().toISOString()}] \${payload.event} \${payload.error?.stage}: \${payload.error?.message}\\n\`;
// const logFile = Bun.file('.pkglab/error.log');
// const existing = await logFile.exists() ? await logFile.text() : '';
// await Bun.write(logFile, existing + entry);
`,
};

export default defineCommand({
  meta: { name: 'init', description: 'Scaffold hooks directory with type definitions and stubs' },
  async run() {
    const hooksDir = resolve(process.cwd(), '.pkglab', 'hooks');

    // Check if the directory already exists by trying to read a known file
    const dirFile = Bun.file(resolve(hooksDir, 'payload.d.ts'));
    if (await dirFile.exists()) {
      log.warn('.pkglab/hooks/ already exists. Skipping to avoid overwriting existing hooks.');
      return;
    }

    // Also check if the directory itself exists (even without payload.d.ts)
    try {
      const { exitCode } = Bun.spawnSync(['test', '-d', hooksDir]);
      if (exitCode === 0) {
        log.warn('.pkglab/hooks/ already exists. Skipping to avoid overwriting existing hooks.');
        return;
      }
    } catch {
      // directory doesn't exist, proceed
    }

    // Write payload.d.ts
    await Bun.write(resolve(hooksDir, 'payload.d.ts'), PAYLOAD_DTS);

    // Write all hook stubs
    const writes = Object.entries(HOOK_STUBS).map(([filename, content]) =>
      Bun.write(resolve(hooksDir, filename), content),
    );
    await Promise.all(writes);
    // Stubs were written by pkglab just now, so they start out trusted.
    await trustHooks(process.cwd());

    log.success('Created .pkglab/hooks/ with type definitions and hook stubs.');
    log.line('');
    log.line('  Files created:');
    log.line('    payload.d.ts       Type definition for hook payloads');
    log.line('    pre-add.ts         Runs before pkglab add');
    log.line('    post-add.ts        Runs after pkglab add');
    log.line('    pre-restore.ts     Runs before pkglab restore');
    log.line('    post-restore.ts    Runs after pkglab restore');
    log.line('    pre-update.ts      Runs before pkglab pub auto-update');
    log.line('    post-update.ts     Runs after pkglab pub auto-update');
    log.line('    on-error.ts        Runs when an operation fails');
    log.line('');
    log.line('  All hooks are no-ops (code is commented out).');
    log.line('  Uncomment and edit a hook file to add behavior.');
  },
});
