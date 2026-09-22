import { join } from 'node:path';

export default {
  tool: 'grok',
  label: 'Grok Build',
  kind: 'jsonl',
  version: 3, // #96：`modelUsage:{}` 的轮次整条被丢，须全量重扫补回丢失的事件
          // #85：秒/毫秒归一交给共享的 epochMs()（边界从 1e12 收进 1e11、并认 ISO）
  collector: 'grok',
  order: 6,
  roots(ctx) {
    return [join(ctx.homedir, '.grok', 'sessions')];
  },
};
