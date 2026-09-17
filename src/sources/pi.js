import { join } from 'node:path';

export default {
  tool: 'pi',
  label: 'Pi',
  kind: 'jsonl',
  version: 1,
  collector: 'pi',
  order: 8,
  roots(ctx) {
    return [join(ctx.homedir, '.pi', 'agent', 'sessions')];
  },
};
