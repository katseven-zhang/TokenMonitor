import { join } from 'node:path';

export default {
  tool: 'dsh',
  label: 'dsh',
  kind: 'zst',
  version: 3,
  collector: 'dsh',
  apiBilled: true,
  order: 5,
  roots(ctx) {
    return [join(ctx.homedir, '.dsh', 'sessions')];
  },
};
