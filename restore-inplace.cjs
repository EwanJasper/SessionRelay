const Database = require('better-sqlite3');
const path = require('path'), fs = require('fs');

function restore(livePath, bakPath) {
  console.log('\n===== ' + livePath);
  if (!fs.existsSync(bakPath)) { console.log('  备份不存在: ' + bakPath); return false; }
  const db = new Database(livePath);
  db.pragma('busy_timeout = 15000');
  db.exec("ATTACH DATABASE '" + bakPath.replace(/'/g, "''") + "' AS bak");

  const objs = db.prepare("SELECT type,name,tbl_name,sql FROM bak.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
  // FTS 影子表由虚拟表自动创建，不能手建
  const shadow = /_(data|idx|content|docsize|config)$/;
  const virtual = new Set(objs.filter(o => /VIRTUAL TABLE/i.test(o.sql)).map(o => o.name));
  const isShadow = (n) => shadow.test(n) && [...virtual].some(v => n.startsWith(v + '_'));

  const tables = objs.filter(o => o.type === 'table' && !isShadow(o.name));
  const others = objs.filter(o => o.type === 'index' || o.type === 'trigger');
  const plain = tables.filter(o => !/VIRTUAL TABLE/i.test(o.sql));
  const fts = tables.filter(o => /VIRTUAL TABLE/i.test(o.sql));

  let ddl = 0;
  for (const o of tables) { try { db.exec(o.sql); ddl++; } catch (e) { console.log('  DDL失败 ' + o.name + ': ' + e.message.slice(0, 60)); } }

  let rows = 0;
  for (const o of plain) {
    try { const r = db.prepare('INSERT INTO main."' + o.name + '" SELECT * FROM bak."' + o.name + '"').run(); rows += r.changes; }
    catch (e) { console.log('  数据失败 ' + o.name + ': ' + e.message.slice(0, 60)); }
  }
  for (const o of others) { try { db.exec(o.sql); } catch (e) { /* 索引重名可忽略 */ } }
  for (const o of fts) {
    try { db.exec("INSERT INTO main." + o.name + "(" + o.name + ") VALUES('rebuild')"); console.log('  FTS 重建 ' + o.name); }
    catch (e) { console.log('  FTS重建失败 ' + o.name + ': ' + e.message.slice(0, 60)); }
  }
  db.exec('DETACH DATABASE bak');
  console.log('  建表 ' + ddl + ' 个 · 灌入 ' + rows + ' 行');

  const c = (s) => { try { return db.prepare(s).get().c; } catch (e) { return 'ERR'; } };
  console.log('  校验 sessions=' + c('SELECT count(*) c FROM sessions') + ' messages=' + c('SELECT count(*) c FROM messages'));
  console.log('  integrity=' + db.prepare('PRAGMA integrity_check').get().integrity_check);
  db.close();
  return true;
}
restore('D:/agent1super/.sessionrelay/relay.sqlite', 'D:/agent1super/.sessionrelay/relay.sqlite.damaged-2026-10-17T2049');
