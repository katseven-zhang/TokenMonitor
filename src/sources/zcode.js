import { join } from 'node:path';

export default {
  tool: 'zcode',
  label: 'ZCode',
  kind: 'sqlite',
  version: 2,
  collector: 'zcode',
  order: 4,
  roots(ctx) {
    return [join(ctx.homedir, '.zcode', 'cli', 'db', 'db.sqlite')];
  },
};
