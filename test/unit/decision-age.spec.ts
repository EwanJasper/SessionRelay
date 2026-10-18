import { describe, it, expect } from 'vitest';
import { DECISION_STALE_DAYS, decisionAgeDays } from '../../src/store/decision-validity.js';

/**
 * 决策时效（不是推翻）。
 *
 * 为什么测这个：这一整条路径的**唯一目的**是「如实说出多旧」，一旦算错，
 *   要么把今天刚定的标成老古董（没人再信），要么把三个月前的当成新鲜的（更糟）。
 *   它同时也是「本仓不做自动推翻」这个决定的可执行形式 —— 只加信息，不藏东西。
 */
const DAY = 86400000;
const NOW = Date.parse('2026-10-18T12:00:00.000Z');

describe('decisionAgeDays', () => {
  it('今天定的 = 0 天', () => {
    expect(decisionAgeDays('2026-10-18T12:00:00.000Z', NOW)).toBe(0);
    expect(decisionAgeDays('2026-10-18T01:00:00.000Z', NOW)).toBe(0);
  });

  it('整日向下取整（29.9 天算 29，不到 30 不打旧标）', () => {
    expect(decisionAgeDays(new Date(NOW - 29.9 * DAY).toISOString(), NOW)).toBe(29);
    expect(decisionAgeDays(new Date(NOW - 30 * DAY).toISOString(), NOW)).toBe(30);
    expect(decisionAgeDays(new Date(NOW - 400 * DAY).toISOString(), NOW)).toBe(400);
  });

  it('未来时间按 0 处理（时钟回拨不许显示成「-3 天前」）', () => {
    expect(decisionAgeDays(new Date(NOW + 3 * DAY).toISOString(), NOW)).toBe(0);
  });

  it('解析不了 / 空 / null ⇒ null（不知道就说不不知道，不猜成 0）', () => {
    for (const at of ['', '   ', 'not-a-date', null, undefined]) {
      expect(decisionAgeDays(at as any, NOW), String(at)).toBe(null);
    }
  });

  it('旧标阈值是 30 天且只有这一份（简报/CLI/MCP 三处都读它）', () => {
    expect(DECISION_STALE_DAYS).toBe(30);
  });
});
