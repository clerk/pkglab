import { defineCommand } from 'citty';

import { trustHooks } from '../../lib/hooks';
import { log } from '../../lib/log';

export default defineCommand({
  meta: { name: 'trust', description: "Trust the current repo's hooks so pkglab will run them" },
  async run() {
    const trusted = await trustHooks(process.cwd());
    if (trusted.length === 0) {
      log.info('No hooks found in .pkglab/hooks/');
      return;
    }
    for (const path of trusted) {
      log.success(`Trusted ${path}`);
    }
    log.dim('Hooks are re-checked by content: edit one and you need to trust it again.');
  },
});
