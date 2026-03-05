import { defineCommand } from 'citty';

import { loadConfig } from '../../lib/config';
import { activateRepo } from '../../lib/repo-state';
import { runToggle } from './toggle-helper';

export default defineCommand({
  meta: { name: 'on', description: 'Activate repo for auto-updates' },
  args: {
    name: { type: 'positional', description: 'Repo path', required: false },
    all: { type: 'boolean', description: 'Activate all repos', default: false },
  },
  async run({ args }) {
    const config = await loadConfig();

    await runToggle(args, {
      verb: 'activate',
      pastTense: 'Activated',
      shouldSkip: s => s.active,
      pickerFilter: s => !s.active,
      allDoneMessage: 'All repos are already active',
      pickerEmptyMessage: 'All repos are already active.',
      apply: state => activateRepo(state, config.port),
    });
  },
});
