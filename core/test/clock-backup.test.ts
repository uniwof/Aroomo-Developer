/**
 * 假时钟 5：夜间备份到点触发（工单 #230，D49/D65）。
 * 夜间备份不在 Core 里，而是备份 sidecar 里的 crond（deploy/backup/entrypoint.sh，默认 BACKUP_CRON=30 3 * * *，
 * 容器时区 TZ=Asia/Shanghai）调用 scripts/backup.sh。Core 没有备份任务，所以这里分两层测：
 *   1. 调度器层面：用 Core 的 Scheduler + 假定时器 + 打桩的备份命令，证明「到点触发、每 24 小时一次、不重叠、
 *      失败不影响明晚、停掉后不再触发」这套调度语义；
 *   2. 配置层面：sidecar 的默认 cron 是凌晨 3:30 北京时间，入口脚本把它写进 crontab 并调用 backup.sh，
 *      备份不按账号过滤（所有账号的数据都在同一份加密备份里，一个账号的数据不会被漏掉）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/jobs/scheduler.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('夜间备份：调度器层面（打桩备份命令）', () => {
  let audits: Array<{ action: string; target: string; outcome: string; detail?: string }>;
  let runs: number[];
  let sched: Scheduler;
  const stubBackup = (opts: { fail?: () => boolean; hangMs?: () => number } = {}) => ({
    name: 'nightly-backup',
    intervalMs: DAY,
    firstDelayMs: 0,
    async run() {
      runs.push(Date.now());
      const wait = opts.hangMs?.() ?? 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (opts.fail?.()) throw new Error('backup exited 1');
      return 'snapshot=stub';
    },
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-27T03:30:00+08:00') });
    audits = [];
    runs = [];
    sched = new Scheduler(async (action, target, outcome, detail) => {
      audits.push({ action, target: (target as { id: string }).id, outcome, ...(detail ? { detail } : {}) });
    });
  });
  afterEach(() => {
    sched.stop();
    vi.useRealTimers();
  });

  it('到点触发一次，之后每 24 小时一次（连跑 3 个晚上，都是北京时间 3:30）', async () => {
    sched.add(stubBackup());
    sched.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DAY - 2);
    expect(runs).toHaveLength(1); // 差一点点还没到第二个晚上
    await vi.advanceTimersByTimeAsync(2);
    expect(runs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(runs).toHaveLength(3);
    expect(runs.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(['19:30', '19:30', '19:30']); // UTC 19:30 = 北京 03:30
  });

  it('上一次还没跑完，下一次到点也不重叠（被跳过，之后的晚上照常）', async () => {
    sched.add(stubBackup({ hangMs: () => 30 * HOUR }));
    sched.start();
    await vi.advanceTimersByTimeAsync(DAY + 1); // 第二个晚上到了，但第一次还在跑
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7 * HOUR); // 第一次跑完（30 小时）
    await vi.advanceTimersByTimeAsync(DAY); // 第三个晚上
    expect(runs).toHaveLength(2);
  });

  it('某晚失败：记一条失败审计，明晚照常再跑', async () => {
    let n = 0;
    sched.add(stubBackup({ fail: () => ++n === 1 }));
    sched.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(audits.at(-1)).toMatchObject({ action: 'job.run', target: 'nightly-backup', outcome: 'failed' });
    await vi.advanceTimersByTimeAsync(DAY);
    expect(runs).toHaveLength(2);
    expect(audits.at(-1)).toMatchObject({ action: 'job.run', target: 'nightly-backup', outcome: 'ok', detail: 'snapshot=stub' });
  });

  it('stop() 之后不再触发', async () => {
    sched.add(stubBackup());
    sched.start();
    await vi.advanceTimersByTimeAsync(1);
    sched.stop();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(runs).toHaveLength(1);
  });

  it('跨账号：任务审计只记任务名和结果，不带任何账号或用户数据', async () => {
    sched.add(stubBackup());
    sched.start();
    await vi.advanceTimersByTimeAsync(1);
    const text = JSON.stringify(audits);
    expect(text).not.toMatch(/user_id|userId|xiaohao|@example/);
    expect(audits.every((a) => a.target === 'nightly-backup')).toBe(true);
  });
});

describe('夜间备份：sidecar 配置层面', () => {
  const compose = read('deploy/docker-compose.yml');
  const entry = read('deploy/backup/entrypoint.sh');
  const backup = read('scripts/backup.sh');

  it('默认每天凌晨 3:30，按北京时间', () => {
    expect(compose).toMatch(/BACKUP_CRON:\s*\$\{BACKUP_CRON:-30 3 \* \* \*\}/);
    const svc = compose.slice(compose.indexOf('  backup:\n'), compose.indexOf('  restore:'));
    expect(svc).toMatch(/TZ:\s*\$\{TZ:-Asia\/Shanghai\}/);
  });

  it('入口脚本把 cron 写进 crontab，并调用 backup.sh；crond 拿得到备份变量', () => {
    expect(entry).toContain('${BACKUP_CRON:-30 3 * * *}');
    expect(entry).toContain('/opt/aroomo/scripts/backup.sh');
    expect(entry).toMatch(/\^\(BACKUP_\|RETENTION_\|PG\|TZ\$\)/);
    expect(entry).toContain('crond -f');
  });

  it('跨账号：备份脚本备份全部库、不按 user_id 过滤，所有账号的数据都在同一份备份里', () => {
    expect(backup).not.toMatch(/user_id/);
    expect(backup).toContain('BACKUP_DATABASES');
    expect(backup).toMatch(/pg_dump/);
  });

  it('没有公钥时 sidecar 空转而不是假装备份', () => {
    expect(entry).toMatch(/BACKUP_AGE_RECIPIENT[^\n]*未设置[^\n]*空转/);
  });
});
