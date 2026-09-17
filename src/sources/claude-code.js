import { join } from 'node:path';

export default {
  tool: 'claude-code',
  label: 'Claude Code',
  kind: 'jsonl',
  version: 2,
  collector: 'claude',
  order: 1,
  roots(ctx) {
    return [join(ctx.homedir, '.claude', 'projects')];
  },
};
