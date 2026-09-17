import { join } from 'node:path';

export default {
  tool: 'grok',
  label: 'Grok Build',
  kind: 'jsonl',
  version: 1,
  collector: 'grok',
  order: 6,
  roots(ctx) {
    return [join(ctx.homedir, '.grok', 'sessions')];
  },
};
