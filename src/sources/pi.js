import { join } from 'node:path';

export default {
  tool: 'pi',
  label: 'Pi',
  kind: 'jsonl',
  version: 2, // #96：首行 BOM 让 project 永久为 null，须全量重扫把首行再读一遍
  collector: 'pi',
  order: 8,
  roots(ctx) {
    return [join(ctx.homedir, '.pi', 'agent', 'sessions')];
  },
};
