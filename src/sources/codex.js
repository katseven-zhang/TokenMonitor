import { join } from 'node:path';

export default {
  tool: 'codex',
  label: 'Codex',
  kind: 'jsonl',
  version: 5, // #85：custom_tool_call 计入工具活动 + 无 call_id 的调用不再共用同一个去重键
          //（此前同一 seq 内的第二条被 INSERT OR IGNORE 静默丢掉），须全量重扫补回
  collector: 'codex',
  order: 3,
  roots(ctx) {
    return [
      join(ctx.homedir, '.codex', 'sessions'),
      join(ctx.homedir, '.codex', 'archived_sessions'),
    ];
  },
};
