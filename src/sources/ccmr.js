import { join } from 'node:path';

export default {
  tool: 'ccmr',
  label: 'ccmr',
  kind: 'jsonl',
  version: 3,
  collector: 'claude',
  apiBilled: true,
  order: 2,
  roots(ctx) {
    return [join(ctx.homedir, '.claude-gateway', 'projects')];
  },
};
