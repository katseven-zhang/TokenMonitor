import { join } from 'node:path';

export default {
  tool: 'codex',
  label: 'Codex',
  kind: 'jsonl',
  version: 3,
  collector: 'codex',
  order: 3,
  roots(ctx) {
    return [
      join(ctx.homedir, '.codex', 'sessions'),
      join(ctx.homedir, '.codex', 'archived_sessions'),
    ];
  },
};
