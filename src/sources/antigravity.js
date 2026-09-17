import { join } from 'node:path';

/**
 * Antigravity（Google 的 agentic IDE / CLI）在本机落一份 SQLite 用量数据面：
 *   <home>/conversation_summaries.db          会话索引（title / workspace_uris）
 *   <home>/conversations/<uuid>.db            每会话一库，gen_metadata 表逐次记录 LLM 生成
 * home 候选（按发现顺序）：ANTIGRAVITY_HOME 环境变量 → ~/.gemini/antigravity
 * （Windows IDE 实测存在的默认 home）→ ~/.gemini/antigravity-{cli,acp,ide} 变体。
 *
 * sqlite 源的 root 必须是"文件"（scanner 对 sqlite root 直接 stat），而会话库是
 * 动态增减的多个文件，故以每个 home 的 conversation_summaries.db 作为稳定扫描
 * 锚点；collector 被触发时自行枚举同级的 conversations/*.db。
 */
export default {
  tool: 'antigravity',
  label: 'Antigravity',
  kind: 'sqlite',
  version: 1,
  collector: 'antigravity',
  order: 10,
  roots(ctx) {
    const homes = [];
    if (ctx.env && ctx.env.ANTIGRAVITY_HOME) homes.push(ctx.env.ANTIGRAVITY_HOME);
    homes.push(join(ctx.homedir, '.gemini', 'antigravity'));
    for (const variant of ['cli', 'acp', 'ide']) {
      homes.push(join(ctx.homedir, '.gemini', `antigravity-${variant}`));
    }
    return homes.map((h) => join(h, 'conversation_summaries.db'));
  },
};
