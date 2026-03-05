import { cursorHide } from '@inquirer/ansi';
import {
  createPrompt,
  useState,
  useKeypress,
  usePrefix,
  usePagination,
  useMemo,
  makeTheme,
  ExitPromptError,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isEnterKey,
  isBackspaceKey,
} from '@inquirer/core';
import figures from '@inquirer/figures';
import { styleText } from 'node:util';

import type { RepoEntry, RepoState } from '../types';

import { c } from './color';
import { log } from './log';
import { loadOperationalRepos } from './repo-state';

export type RepoChoice = RepoEntry;

interface CheckboxChoice {
  value: string;
  name: string;
  description?: string;
  checked?: boolean;
}

interface NormalizedChoice {
  value: string;
  name: string;
  short: string;
  description?: string;
  checked: boolean;
}

function normalize(choices: CheckboxChoice[]): NormalizedChoice[] {
  return choices.map(c => ({
    value: c.value,
    name: c.name ?? c.value,
    short: c.value,
    description: c.description,
    checked: c.checked ?? false,
  }));
}

const theme = {
  icon: {
    checked: styleText('green', figures.circleFilled),
    unchecked: figures.circle,
    cursor: figures.pointer,
  },
  style: {
    description: (text: string) => styleText('cyan', text),
    highlight: (text: string) => styleText('bold', text),
    help: (text: string) => c.dim(text),
  },
};

export const filterableCheckbox = createPrompt<
  string[],
  { message: string; choices: CheckboxChoice[]; pageSize?: number }
>((config, done) => {
  const { pageSize = 7 } = config;
  const promptTheme = makeTheme({});
  const [status, setStatus] = useState<string>('idle');
  const prefix = usePrefix({ status, theme: promptTheme });
  const [items, setItems] = useState(normalize(config.choices));
  const [searchTerm, setSearchTerm] = useState('');
  const [active, setActive] = useState(0);

  const filtered = useMemo(() => {
    if (!searchTerm) {
      return items.map((item, i) => ({ item, idx: i }));
    }
    const lower = searchTerm.toLowerCase();
    return items.map((item, i) => ({ item, idx: i })).filter(({ item }) => item.name.toLowerCase().includes(lower));
  }, [items, searchTerm]);

  useKeypress(key => {
    if (isEnterKey(key)) {
      setStatus('done');
      done(items.filter(i => i.checked).map(i => i.value));
    } else if (isUpKey(key)) {
      setActive(Math.max(0, active - 1));
    } else if (isDownKey(key)) {
      setActive(Math.min(filtered.length - 1, active + 1));
    } else if (isSpaceKey(key)) {
      const entry = filtered[active];
      if (entry) {
        setItems(items.map((item, i) => (i === entry.idx ? { ...item, checked: !item.checked } : item)));
      }
    } else if (isBackspaceKey(key)) {
      if (searchTerm.length > 0) {
        setSearchTerm(searchTerm.slice(0, -1));
        setActive(0);
      }
    } else if (key.name && key.name.length === 1 && !key.ctrl) {
      setSearchTerm(searchTerm + key.name);
      setActive(0);
    }
  });

  const message = promptTheme.style.message(config.message, status);

  if (status === 'done') {
    const selection = items.filter(i => i.checked);
    const answer = promptTheme.style.answer(selection.map(s => s.short).join(', '));
    return [prefix, message, answer].filter(Boolean).join(' ');
  }

  let description: string | undefined;

  const page = usePagination({
    items: filtered,
    active,
    renderItem({ item: { item }, isActive }) {
      if (isActive) {
        description = item.description;
      }
      const checkbox = item.checked ? theme.icon.checked : theme.icon.unchecked;
      const cursor = isActive ? theme.icon.cursor : ' ';
      const name = isActive ? theme.style.highlight(item.name) : item.name;
      return `${cursor}${checkbox} ${name}`;
    },
    pageSize,
    loop: false,
  });

  const filterLine = searchTerm ? `  ${c.dim('filter:')} ${searchTerm}` : `  ${c.dim('filter: type...')}`;

  const helpLine = theme.style.help(
    [
      `${styleText('bold', '↑↓')} navigate`,
      `${styleText('bold', 'space')} select`,
      `${styleText('bold', 'type')} filter`,
      `${styleText('bold', '⏎')} submit`,
    ].join(c.dim(' · ')),
  );

  const lines = [
    [prefix, message].filter(Boolean).join(' '),
    filterLine,
    page,
    ' ',
    description ? theme.style.description(description) : '',
    helpLine,
  ]
    .filter(Boolean)
    .join('\n')
    .trimEnd();

  return `${lines}${cursorHide}`;
});

export async function selectRepos(opts: {
  message: string;
  filter?: (state: RepoState) => boolean;
  emptyMessage?: string;
  preSelect?: Set<string>;
}): Promise<RepoChoice[]> {
  const all = await loadOperationalRepos();

  if (all.length === 0) {
    log.info(opts.emptyMessage ?? 'No repos linked. Use pkglab add in a consumer repo.');
    return [];
  }

  const filtered = (opts.filter ? all.filter(entry => opts.filter!(entry.state)) : all).toSorted(
    (a, b) => (b.state.lastUsed ?? 0) - (a.state.lastUsed ?? 0),
  );

  if (filtered.length === 0) {
    log.info(opts.emptyMessage ?? 'No matching repos.');
    return [];
  }

  let selected: string[];
  try {
    selected = await filterableCheckbox({
      message: opts.message,
      choices: filtered.map(({ displayName, state }) => {
        const pkgs = Object.keys(state.packages);
        const description = pkgs.length > 0 ? pkgs.join(', ') : 'no packages';
        return {
          value: state.path,
          name: `${displayName} ${c.dim(state.path)}`,
          description,
          checked: opts.preSelect?.has(state.path) ?? false,
        };
      }),
    });
  } catch (err) {
    if (err instanceof ExitPromptError) {
      process.exit(0);
    }
    throw err;
  }

  process.stdin.unref();

  const selectedPaths = new Set(selected);
  return filtered
    .filter(entry => selectedPaths.has(entry.state.path))
    .map(({ displayName, state }) => ({ displayName, state }));
}
