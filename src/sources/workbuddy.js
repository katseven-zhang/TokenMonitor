import { join } from 'node:path';

export default {
  tool: 'workbuddy',
  label: 'WorkBuddy',
  kind: 'jsonl',
  version: 1,
  collector: 'workbuddy',
  order: 7,
  roots(ctx) {
    return [join(ctx.homedir, '.WorkBuddy', 'projects')];
  },
};
