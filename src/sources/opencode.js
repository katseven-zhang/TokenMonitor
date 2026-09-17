import { join } from 'node:path';

export default {
  tool: 'opencode',
  label: 'OpenCode',
  kind: 'sqlite',
  version: 2,
  collector: 'opencode',
  order: 9,
  roots(ctx) {
    const bases = [ctx.xdgDataHome, join(ctx.homedir, '.local', 'share'), ctx.localAppData];
    return bases.filter(Boolean).map((b) => join(b, 'opencode', 'opencode.db'));
  },
};
