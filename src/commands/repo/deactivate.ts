import { defineCommand } from 'citty';

import { saveRepoByPath } from '../../lib/repo-state';
import { runToggle } from './toggle-helper';

export default defineCommand({
  meta: { name: 'off', description: 'Deactivate repo for auto-updates' },
  args: {
    name: { type: 'positional', description: 'Repo path', required: false },
    all: { type: 'boolean', description: 'Deactivate all repos', default: false },
  },
  async run({ args }) {
    await runToggle(args, {
      verb: 'deactivate',
      pastTense: 'Deactivated',
      shouldSkip: s => !s.active,
      pickerFilter: s => s.active,
      allDoneMessage: 'No repos are currently active',
      pickerEmptyMessage: 'No repos are currently active.',
      apply: async state => {
        state.active = false;
        await saveRepoByPath(state.path, state);
      },
    });
  },
});
