import { rename } from 'node:fs/promises';

export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, content);
  await rename(tmp, path);
}
