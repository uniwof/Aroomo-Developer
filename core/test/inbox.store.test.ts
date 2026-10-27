import { describe, expect, it } from 'vitest';
import { ConfirmTokenManager } from '../src/inbox/confirm.js';
import { createInboxItem, InboxService } from '../src/inbox/service.js';
import { InboxConflictError, InMemoryInboxStore } from '../src/inbox/store.js';

describe('InMemoryInboxStore & InboxService', () => {
  it('should list items sorted by status (open first), urgency (urgent > normal > low), and createdAt descending', async () => {
    const store = new InMemoryInboxStore();

    // Create items out of order
    const item1 = await store.create({
      group: 'decision',
      kind: 'k1',
      urgency: 'low',
      title: 'Low urgency open',
      summary: 's1',
    });
    // Wait slightly to ensure distinct timestamps
    await new Promise((r) => setTimeout(r, 10));

    const item2 = await store.create({
      group: 'decision',
      kind: 'k2',
      urgency: 'urgent',
      title: 'Urgent open',
      summary: 's2',
    });
    await new Promise((r) => setTimeout(r, 10));

    const item3 = await store.create({
      group: 'decision',
      kind: 'k3',
      urgency: 'normal',
      title: 'Normal open older',
      summary: 's3',
    });
    await new Promise((r) => setTimeout(r, 10));

    const item4 = await store.create({
      group: 'decision',
      kind: 'k4',
      urgency: 'normal',
      title: 'Normal open newer',
      summary: 's4',
    });
    await new Promise((r) => setTimeout(r, 10));

    const item5 = await store.create({
      group: 'decision',
      kind: 'k5',
      urgency: 'urgent',
      title: 'Urgent done',
      summary: 's5',
      actions: [{ id: 'act1', label: 'Action 1' }],
    });
    await store.executeAction(item5.id, 'act1');

    const items = await store.list();

    // Verify ordering:
    // 1-4 are open, item5 is done (so item5 must be last)
    // Among open:
    // urgent: item2
    // normal: item4 (newer), item3 (older)
    // low: item1
    expect(items.map((i) => i.id)).toEqual([item2.id, item4.id, item3.id, item1.id, item5.id]);
  });

  it('should deduplicate open items with the same kind and related object', async () => {
    const store = new InMemoryInboxStore();
    const related = { type: 'agent_task', id: 'task-123' };

    const first = await store.create({
      group: 'decision',
      kind: 'takeover',
      title: 'Takeover Task',
      summary: 'Summary 1',
      related,
    });

    const second = await store.create({
      group: 'decision',
      kind: 'takeover',
      title: 'Takeover Task Duplicate',
      summary: 'Summary 2',
      related,
    });

    expect(second.id).toBe(first.id);
    expect(second.title).toBe(first.title);

    const list = await store.list();
    expect(list.length).toBe(1);

    // If resolved, a new open item with the same related + kind can be created
    await store.dismiss(first.id);

    const third = await store.create({
      group: 'decision',
      kind: 'takeover',
      title: 'New Takeover Task',
      summary: 'Summary 3',
      related,
    });

    expect(third.id).not.toBe(first.id);
    const updatedList = await store.list();
    expect(updatedList.length).toBe(2);
  });

  it('should allow only one concurrent action execution to succeed (Promise.all)', async () => {
    const store = new InMemoryInboxStore();
    const item = await store.create({
      group: 'decision',
      kind: 'approval',
      title: 'Approve Request',
      summary: 'Summary',
      actions: [{ id: 'approve', label: 'Approve' }],
    });

    const results = await Promise.allSettled([
      store.executeAction(item.id, 'approve'),
      store.executeAction(item.id, 'approve'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(InboxConflictError);
    }

    const updated = await store.findById(item.id);
    expect(updated?.status).toBe('done');
    expect(updated?.resolvedAction).toBe('approve');
  });

  it('should handle irreversible action confirmation workflow, token expiration, invalid token, and replay prevention', async () => {
    const tokenManager = new ConfirmTokenManager(50); // 50ms TTL for testing expiration
    const service = new InboxService(new InMemoryInboxStore(), tokenManager);

    const item = await service.createInboxItem({
      group: 'decision',
      kind: 'key_rotation',
      title: 'Rotate Salt Key',
      summary: 'Irreversible key rotation',
      actions: [{ id: 'rotate', label: 'Rotate Key', irreversible: true }],
    });

    // 1. Without confirmToken -> returns needsConfirm with confirmToken
    const firstTry = await service.executeAction(item.id, 'rotate');
    expect('needsConfirm' in firstTry && firstTry.needsConfirm).toBe(true);
    const token = 'confirmToken' in firstTry ? firstTry.confirmToken : '';
    expect(token).toBeTruthy();

    // 2. Replay prevention / Invalid token: try wrong token
    await expect(service.executeAction(item.id, 'rotate', 'invalid-token')).rejects.toThrow(
      'Invalid, expired, or replayed confirmToken',
    );

    // 3. Token expiration test
    const secondTry = await service.executeAction(item.id, 'rotate');
    const expToken = 'confirmToken' in secondTry ? secondTry.confirmToken : '';
    await new Promise((r) => setTimeout(r, 60)); // Wait for token to expire
    await expect(service.executeAction(item.id, 'rotate', expToken)).rejects.toThrow(
      'Invalid, expired, or replayed confirmToken',
    );

    // 4. Valid confirmation token execution
    const thirdTry = await service.executeAction(item.id, 'rotate');
    const validToken = 'confirmToken' in thirdTry ? thirdTry.confirmToken : '';
    const successResult = await service.executeAction(item.id, 'rotate', validToken);
    expect('success' in successResult && successResult.success).toBe(true);

    // 5. Replay token: trying the same token again must fail
    await expect(service.executeAction(item.id, 'rotate', validToken)).rejects.toThrow();
  });

  it('should update status on dismiss and batchDismiss', async () => {
    const service = new InboxService();
    const item1 = await service.createInboxItem({
      group: 'candidate',
      kind: 'resource',
      title: 'Candidate 1',
      summary: 's1',
    });
    await service.createInboxItem({
      group: 'candidate',
      kind: 'resource',
      title: 'Candidate 2',
      summary: 's2',
    });
    const item3 = await service.createInboxItem({
      group: 'brief',
      kind: 'daily',
      title: 'Daily Brief',
      summary: 's3',
    });

    expect(await service.getUnreadCount()).toBe(3);

    // Dismiss single item
    const dismissed1 = await service.dismissItem(item1.id);
    expect(dismissed1.status).toBe('dismissed');
    expect(await service.getUnreadCount()).toBe(2);

    // Batch dismiss candidate group
    const batchCount = await service.batchDismissItems({ group: 'candidate' });
    expect(batchCount).toBe(1); // item2
    expect(await service.getUnreadCount()).toBe(1); // item3 remaining

    const remaining = await service.getItem(item3.id);
    expect(remaining?.status).toBe('open');
  });

  it('should support internal function createInboxItem', async () => {
    const item = await createInboxItem({
      group: 'brief',
      kind: 'summary',
      title: 'Test Brief',
      summary: 'Summary text',
    });
    expect(item.id).toBeTruthy();
    expect(item.status).toBe('open');
  });
});
