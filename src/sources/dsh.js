import { join } from 'node:path';

export default {
  tool: 'dsh',
  label: 'dsh',
  kind: 'zst',
  version: 4, // #85：`time` 秒级粒度归一，须全量重扫把落错年份的事件读回正确窗口
  collector: 'dsh',
  apiBilled: true,
  order: 5,
  roots(ctx) {
    return [join(ctx.homedir, '.dsh', 'sessions')];
  },
};
