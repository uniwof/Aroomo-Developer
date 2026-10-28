/**
 * 具体的定时任务。
 * - recycle-bin：回收站里超过 30 天的成员彻底删除（PRODUCT §8.4、D50 写审计）。
 * - confirm-cleanup：过期超过 1 天的确认记录删除（令牌 5 分钟就失效；审计日志里的确认留痕不受影响）。
 * - key-reconcile：本地 Key 记录和 LiteLLM 部署对账（D45：以 LiteLLM 为准）。
 *     本地有、LiteLLM 没有 → 标「同步失败」并发收件箱卡片请用户重新填写；
 *     LiteLLM 有、本地没有的 Aroomo 部署（换 Key / 删 Key 时清理失败留下的）→ 只发收件箱卡片提醒，不自动删除
 *     （删除凭据是重要确认，D73，定时任务不能代替用户点）；
 *     之前同步失败、现在又对得上 → 恢复「可用」。
 */
import type { ChallengeStore } from '../confirm/confirm.js';
import type { InboxService } from '../inbox/service.js';
import type { LiteLLMAdmin } from '../keys/litellm.js';
import type { KeyStore } from '../keys/types.js';
import type { MembersService } from '../members/service.js';
import type { Job } from './scheduler.js';

const HOUR = 60 * 60 * 1000;

export function recycleBinJob(members: MembersService): Job {
  return {
    name: 'recycle-bin',
    intervalMs: 6 * HOUR,
    async run(audit) {
      const ids = await members.sweepExpired(audit);
      return ids.length ? `purged=${ids.length}` : '';
    },
  };
}

export function confirmCleanupJob(store: ChallengeStore, now: () => Date): Job {
  return {
    name: 'confirm-cleanup',
    intervalMs: HOUR,
    async run() {
      const n = await store.deleteExpired(new Date(now().getTime() - 24 * HOUR));
      return n ? `deleted=${n}` : '';
    },
  };
}

export function keyReconcileJob(keys: KeyStore, litellm: LiteLLMAdmin, inbox: InboxService, now: () => Date): Job {
  let lastOrphanKey = '';
  return {
    name: 'key-reconcile',
    intervalMs: HOUR,
    async run(audit) {
      if (!litellm.configured) return 'skipped=not_configured';
      const deployments = await litellm.listDeployments();
      const ids = new Set(deployments.map((d) => d.id));
      const local = await keys.list();
      const localIds = new Set(local.map((k) => k.litellmModelId));
      let missing = 0;
      let restored = 0;
      for (const k of local) {
        if (!ids.has(k.litellmModelId)) {
          missing++;
          // 只在刚发现时发一张卡（每小时对账一次，已标记 sync_failed 的不再重复提醒）
          if (k.status === 'sync_failed') continue;
          await keys.update({ ...k, status: 'sync_failed', updatedAt: now() });
          await audit('keys.reconcile.missing', { type: 'key', id: k.id }, 'failed');
          await inbox.createInboxItem(
            {
              group: 'decision',
              kind: 'key-missing',
              urgency: 'normal',
              title: `Key「${k.name}」在模型网关里找不到了`,
              summary: `末 4 位 ${k.last4}。用这个 Key 的成员现在调不通，请到「成员 → Key 与接入」重新填写（换 Key）。`,
              related: { type: 'key', id: k.id },
              actions: [{ id: 'ack', label: '知道了' }],
            },
            audit,
          );
        } else if (k.status === 'sync_failed') {
          restored++;
          await keys.update({ ...k, status: 'active', updatedAt: now() });
        }
      }
      const orphans = deployments.filter((d) => d.id.startsWith('aroomo-') && !localIds.has(d.id));
      // 多余部署：同一批只提醒一次（进程内记住上次提醒的集合）
      const orphanKey = orphans.map((d) => d.id).sort().join(',');
      const notifyOrphans = orphans.length > 0 && orphanKey !== lastOrphanKey;
      lastOrphanKey = orphanKey;
      if (notifyOrphans) {
        await inbox.createInboxItem(
          {
            group: 'decision',
            kind: 'litellm-orphans',
            urgency: 'low',
            title: `模型网关里有 ${orphans.length} 个多余的部署`,
            summary: '换 Key 或删除 Key 时没清理干净留下的。它们不会被使用；需要的话可以在 LiteLLM 管理界面删除。',
            related: { type: 'litellm', id: 'orphans' },
            actions: [{ id: 'ack', label: '知道了' }],
          },
          audit,
        );
      }
      return [missing && `missing=${missing}`, restored && `restored=${restored}`, orphans.length && `orphans=${orphans.length}`].filter(Boolean).join(' ');
    },
  };
}
