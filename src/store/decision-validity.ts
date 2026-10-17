// Decision validity side-table (content vs validity separation).
// - sessions.decisions JSON stays the ONLY content source; this table only records validity.
// - Keys are normalized by decisionKey() and nowhere else.
// - A decision with NO row is treated as active (compatibility invariant, tested).
import type { DB } from './db.js';

export const DECISION_KEY_MAX = 40;

/**
 * Normalize a decision text into a stable key. Rules and why:
 * 1. NFKC: full-width and half-width letters are the same sentence (Chinese IME mixes them).
 * 2. lowercase: case never changes a decision's meaning (PostgreSQL == postgresql).
 * 3. drop whitespace: layout must not split one decision into two keys.
 * 4. drop punctuation/symbols: tables and mixed CN/EN punctuation must not split one decision.
 * 5. truncate at 40 chars: same length as dedupKey, so keys stay comparable across features;
 *    long decisions sharing the first 40 chars share a key (acceptable; superseded_by traces it).
 */
export function decisionKey(text: string | null | undefined): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[\p{P}\p{S}]+/gu, '')
    .slice(0, DECISION_KEY_MAX);
}

export interface DecisionValidityRow {
  session_id: string;
  decision_key: string;
  active: number;
  superseded_by: string | null;
  superseded_at: string | null;
  valid_from: string | null;
  created_at: string;
}

function nowIso(now?: string): string { return now ?? new Date().toISOString(); }

export function activeKeysOf(db: DB, sessionId: string): Set<string> {
  const rows = db.prepare('SELECT decision_key FROM decision_validity WHERE session_id = ? AND active = 1').all(sessionId) as Array<{ decision_key: string }>;
  return new Set(rows.map((r) => r.decision_key));
}

export function validityMapOf(db: DB, sessionId: string): Map<string, number> {
  const rows = db.prepare('SELECT decision_key, active FROM decision_validity WHERE session_id = ?').all(sessionId) as Array<{ decision_key: string; active: number }>;
  return new Map(rows.map((r) => [r.decision_key, Number(r.active)]));
}

export function markSuperseded(db: DB, sessionId: string, oldKey: string, newKey: string, now?: string): { marked: number; insertedOld: boolean; insertedNew: boolean } {
  const at = nowIso(now);
  return db.transaction(() => {
    const old = db.prepare('SELECT decision_key FROM decision_validity WHERE session_id = ? AND decision_key = ?').get(sessionId, oldKey) as { decision_key: string } | undefined;
    let insertedOld = false;
    if (old) {
      db.prepare('UPDATE decision_validity SET active = 0, superseded_by = ?, superseded_at = ? WHERE session_id = ? AND decision_key = ?').run(newKey, at, sessionId, oldKey);
    } else {
      db.prepare('INSERT INTO decision_validity (session_id, decision_key, active, superseded_by, superseded_at, valid_from, created_at) VALUES (?, ?, 0, ?, ?, NULL, ?)').run(sessionId, oldKey, newKey, at, at);
      insertedOld = true;
    }
    const fresh = db.prepare('SELECT decision_key FROM decision_validity WHERE session_id = ? AND decision_key = ?').get(sessionId, newKey) as { decision_key: string } | undefined;
    let insertedNew = false;
    if (!fresh) {
      db.prepare('INSERT INTO decision_validity (session_id, decision_key, active, superseded_by, superseded_at, valid_from, created_at) VALUES (?, ?, 1, NULL, NULL, NULL, ?)').run(sessionId, newKey, at);
      insertedNew = true;
    }
    return { marked: 1, insertedOld, insertedNew };
  })();
}

export function filterActive<T extends { text: string }>(db: DB, sessionId: string, decisions: T[]): T[] {
  const snap = validityMapOf(db, sessionId);
  if (snap.size === 0) return decisions;
  return decisions.filter((d) => snap.get(decisionKey(d.text)) !== 0);
}

export interface BackfillResult {
  dryRun: boolean;
  sessions: number;
  decisions: number;
  inserted: number;
  existing: number;
  skippedEmptyKey: number;
  invalidJson: number;
}

export function backfillDecisionValidity(db: DB, opts?: { dryRun?: boolean; now?: string }): BackfillResult {
  const dryRun = opts?.dryRun === true;
  const at = nowIso(opts?.now);
  const sessions = db.prepare('SELECT id, created_at, decisions FROM sessions WHERE decisions IS NOT NULL AND decisions != ?').all('[]') as Array<{ id: string; created_at: string; decisions: string }>;
  const exists = db.prepare('SELECT 1 FROM decision_validity WHERE session_id = ? AND decision_key = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO decision_validity (session_id, decision_key, active, valid_from, created_at) VALUES (?, ?, 1, ?, ?)');
  const out: BackfillResult = { dryRun, sessions: 0, decisions: 0, inserted: 0, existing: 0, skippedEmptyKey: 0, invalidJson: 0 };
  db.transaction(() => {
    for (const s of sessions) {
      out.sessions++;
      let decs: Array<{ text?: unknown; at?: unknown }> = [];
      try { const parsed = JSON.parse(s.decisions); if (!Array.isArray(parsed)) { out.invalidJson++; continue; } decs = parsed; }
      catch { out.invalidJson++; continue; }
      for (const d of decs) {
        out.decisions++;
        const key = decisionKey(typeof d?.text === 'string' ? d.text : String(d?.text ?? ''));
        if (!key) { out.skippedEmptyKey++; continue; }
        if (exists.get(s.id, key)) { out.existing++; continue; }
        out.inserted++;
        if (!dryRun) insert.run(s.id, key, typeof d?.at === 'string' ? d.at : s.created_at, at);
      }
    }
  })();
  return out;
}

export function validityRowsOf(db: DB, sessionId: string): DecisionValidityRow[] {
  return db.prepare('SELECT * FROM decision_validity WHERE session_id = ? ORDER BY decision_key').all(sessionId) as DecisionValidityRow[];
}
