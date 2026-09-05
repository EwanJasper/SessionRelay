// 语义检索必要性实验：量化现有字面检索（jieba+FTS5）在同义词查询下的 miss 率
// 用法：npx tsx scripts/semantic-miss-experiment.ts
// 语料原则：模拟真实技术对话的自然表述（对话里说什么词，就只含什么词）
import { createDb, insertSession, insertMessage } from '../src/store/db.js';
import { searchSessions } from '../src/search-svc/engine.js';

const db = createDb();
const PID = 'proj-experiment';

// ── 语料：12 个会话，对话内容只含左列表述（自然、克制，不堆关键词） ──
const corpus: Array<{ id: string; title: string; msgs: string[] }> = [
  { id: 'auth001', title: '登录问题排查', msgs: ['用户反馈登录一直转圈', '看了下是 token 过期后前端没有刷新', '加了个静默续期就好了'] },
  { id: 'perf001', title: '接口延迟治理', msgs: ['列表接口要 3 秒才返回', '慢在 N+1 查询，循环里逐条查了数据库', '改成批量 IN 之后降到 80ms'] },
  { id: 'dep001', title: '发布流程整理', msgs: ['每次上线都是手动跑脚本容易出错', '整理成 CI 流水线：构建、跑测试、再部署到 K8s', '以后合并到 main 就自动上线'] },
  { id: 'db001', title: '存储选型讨论', msgs: ['订单量上来后 MySQL 单表撑不住', '评估了分库分表和 TiDB', '最后选了按租户分片的方案'] },
  { id: 'mem001', title: '内存泄漏排查', msgs: ['服务跑三天 RSS 涨到 4G 被 OOMKill', 'heapdump 看到大量未释放的定时器', '修复后曲线平了'] },
  { id: 'refac001', title: '模块解耦', msgs: ['订单模块直接 import 了支付模块的内部函数', '耦合太深改一处崩三处', '抽了个接口层做依赖倒置'] },
  { id: 'ui001', title: '首页白屏修复', msgs: ['低版本浏览器打开首页直接白屏', '是可选链语法没转译', '补了 babel target 配置'] },
  { id: 'sec001', title: '密钥泄漏事故', msgs: ['发现代码库里硬编码了数据库密码还提交到了仓库', '全部改成环境变量注入', '历史提交里的也用 filter-branch 清掉了'] },
  { id: 'cache001', title: '缓存命中率提升', msgs: ['Redis 命中率只有 40%', '热点 key 加了本地 LRU 二级缓存', '命中率到 92%，回源少了大半'] },
  { id: 'test001', title: '回归测试补齐', msgs: ['改个小 bug 手工点一遍太费时间', '给下单主链路补了自动化用例', '现在合并前自动跑'] },
  { id: 'log001', title: '日志规范化', msgs: ['各服务日志格式五花八门没法查', '统一了 JSON 结构化输出和 trace id', '现在能按请求串起全链路'] },
  { id: 'mq001', title: '消息积压处理', msgs: ['大促时 MQ 消息堆了几百万条', '消费者改成批量拉取并发处理', '加了死信队列兜底'] },
];

for (const c of corpus) {
  insertSession(db, { id: c.id, source: 'zcode', sourceSessionId: c.id, projectId: PID, createdAt: '2026-08-20T08:00:00Z', title: c.title, topics: [] });
  c.msgs.forEach((m, i) => insertMessage(db, { sessionId: c.id, role: i % 2 ? 'assistant' : 'user', content: m, seqNum: i + 1, createdAt: '2026-08-20T08:00:00Z' }));
  db.prepare('UPDATE sessions SET message_count = ? WHERE id = ?').run(c.msgs.length, c.id);
}

// ── 查询组：对照（原词，验证检索本身工作正常）与同义（用户/AI 换一种说法） ──
const queries: Array<{ q: string; expect: string; kind: 'control' | 'synonym' }> = [
  { q: '登录 转圈', expect: 'auth001', kind: 'control' },
  { q: 'N+1 批量', expect: 'perf001', kind: 'control' },
  { q: '白屏', expect: 'ui001', kind: 'control' },
  { q: '硬编码 密码', expect: 'sec001', kind: 'control' },
  { q: '死信队列', expect: 'mq001', kind: 'control' },
  // 同义组：语义等价、字面零重叠
  { q: '认证失败如何排查', expect: 'auth001', kind: 'synonym' },
  { q: '接口很慢怎么优化', expect: 'perf001', kind: 'synonym' },
  { q: '部署流程', expect: 'dep001', kind: 'synonym' },
  { q: '数据库压力大了怎么办', expect: 'db001', kind: 'synonym' },
  { q: '服务内存涨上去被杀', expect: 'mem001', kind: 'synonym' },
  { q: '代码耦合想重构', expect: 'refac001', kind: 'synonym' },
  { q: '页面加载不出来', expect: 'ui001', kind: 'synonym' },
  { q: '敏感信息泄露', expect: 'sec001', kind: 'synonym' },
  { q: '回源太多想加缓存', expect: 'cache001', kind: 'synonym' },
  { q: '自动化测试', expect: 'test001', kind: 'synonym' },
  { q: '排查问题缺少链路信息', expect: 'log001', kind: 'synonym' },
  { q: '消息堆积消费不过来', expect: 'mq001', kind: 'synonym' },
];

console.log('kind\tquery\t\t\t期望\t命中\t结果');
let ctlHit = 0, ctlTotal = 0, synHit = 0, synTotal = 0;
const misses: string[] = [];
for (const { q, expect, kind } of queries) {
  const hits = searchSessions(db, { project: PID, query: q, limit: 5 });
  const ok = hits.some((h) => h.sessionId === expect);
  if (kind === 'control') { ctlTotal++; if (ok) ctlHit++; }
  else { synTotal++; if (ok) { synHit++; } else misses.push(`${q} ✗ (期望 ${expect})`); }
  console.log(`${kind === 'control' ? '对照' : '同义'}\t${q.padEnd(16)}\t${expect}\t${hits.map((h) => h.sessionId).join(',') || '∅'}\t${ok ? '✓' : '✗'}`);
}
console.log('─'.repeat(60));
console.log(`对照组：${ctlHit}/${ctlTotal} 命中（验证字面检索本身正常）`);
console.log(`同义组：${synHit}/${synTotal} 命中 —— miss 率 ${(((synTotal - synHit) / synTotal) * 100).toFixed(0)}%`);
if (misses.length) console.log(`未命中的同义查询：\n  ${misses.join('\n  ')}`);
db.close();
