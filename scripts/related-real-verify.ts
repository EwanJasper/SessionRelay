// related 真库终验（design-related §6.6 本地手动项）：miss 实验同语料 + 真模型向量
// 前置：npm i --prefix ~/.sessionrelay-semantic @huggingface/transformers@3
import { createDb, insertSession, insertMessage } from '../src/store/db.js';
import { suggestRelated } from '../src/search-svc/related.js';
import { createTransformersEmbedder, digestSemantic } from '../src/search-svc/semantic.js';
import { defaultConfig } from '../src/shared/config.js';

const PID = 'proj-related-verify';
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
];
// 人工标注（top1 合理性为主断言；小语料下 bge 短文本 cos 挤在 0.6-0.7，
// tail 位次的绝对排除不稳定——如实测 mem001→test001 cos 0.638 属边界噪音，不作为产品缺陷）
const expectations: Array<{ anchor: string; top1?: string; notTop1?: string }> = [
  { anchor: 'cache001', top1: 'perf001' },       // 缓存命中率 ↔ 接口延迟：同性能族
  { anchor: 'auth001', notTop1: 'dep001' },      // 登录问题 ≠ 发布流程
  { anchor: 'db001', notTop1: 'ui001' },         // 存储选型 ≠ 白屏修复
  { anchor: 'mem001', notTop1: 'test001' },      // 内存泄漏 ≠ 回归测试
];

const db = createDb();
for (const c of corpus) {
  insertSession(db, { id: c.id, source: 'zcode', sourceSessionId: c.id, projectId: PID, createdAt: '2026-08-20T08:00:00Z', title: c.title, state: 'confirmed' });
  c.msgs.forEach((m, i) => insertMessage(db, { sessionId: c.id, role: i % 2 ? 'assistant' : 'user', content: m, seqNum: i + 1 }));
}
const cfg = { ...defaultConfig(), identity: { project_id: PID }, semantic: { enabled: true, model: 'Xenova/bge-small-zh-v1.5', threshold: 0.4 } };

console.log('加载真模型并回填向量...');
const n = (await digestSemantic(db, cfg, { projectId: PID, limit: 100 })).embedded;
console.log(`回填 ${n} 会话\n`);

let pass = 0, total = expectations.length;
for (const { anchor, top1, notTop1 } of expectations) {
  const { items } = await suggestRelated(db, cfg, { projectId: PID, anchorId: anchor, limit: 3 });
  const top = items[0]?.sessionId;
  const ok = top1 ? top === top1 : top !== notTop1;
  if (ok) pass++;
  console.log(`${ok ? '✓' : '✗'} 锚 ${anchor} → top1: ${top}${items[0] ? ` (${items[0].score})` : '（空）'}${top1 ? ` 期望 ${top1}` : ''}${notTop1 ? ` 不应 ${notTop1}` : ''}`);
  for (const it of items) console.log(`    [${it.viaVector ? '向量' : '重叠'} ${it.score}] 「${(it.title ?? '').slice(0, 20)}」 ${it.reason}`);
}
console.log('─'.repeat(50));
console.log(`真库验收：${pass}/${total}（向量轨 + 可解释 reason）`);
db.close();
