import { join } from 'node:path';

export default {
  tool: 'grok',
  label: 'Grok Build',
  kind: 'jsonl',
  version: 2, // #96：`modelUsage:{}` 的轮次整条被丢，须全量重扫补回丢失的事件
  collector: 'grok',
  order: 6,
  roots(ctx) {
    return [join(ctx.homedir, '.grok', 'sessions')];
  },
};
