import { parseQuery } from "../src/core/tokenize/tokenizer.js";
for (const q of ["磁盘空间不足怎么办","哪个程序在偷跑占用资源","找人帮我看代码有没有问题","分析记忆系统的优缺点","磁盘空间不足怎么办".normalize()]) {
  const p = parseQuery(q);
  console.log("「" + q + "」 => " + JSON.stringify(p.units.map(u => u.join("+"))));
}