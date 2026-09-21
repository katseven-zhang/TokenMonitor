import { join } from 'node:path';

export default {
  tool: 'workbuddy',
  label: 'WorkBuddy',
  kind: 'jsonl',
  version: 2, // #85：`timestamp` 秒级粒度归一 + cache_write/reasoning 真的读出来，同上
  collector: 'workbuddy',
  order: 7,
  roots(ctx) {
    return [join(ctx.homedir, '.WorkBuddy', 'projects')];
  },
};
