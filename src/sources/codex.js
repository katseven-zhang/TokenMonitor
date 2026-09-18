import { join } from 'node:path';

export default {
  tool: 'codex',
  label: 'Codex',
  kind: 'jsonl',
  version: 4, // #58：resets_at 秒级时间戳归一修正，升版触发全量重扫刷新快照
  collector: 'codex',
  order: 3,
  roots(ctx) {
    return [
      join(ctx.homedir, '.codex', 'sessions'),
      join(ctx.homedir, '.codex', 'archived_sessions'),
    ];
  },
};
