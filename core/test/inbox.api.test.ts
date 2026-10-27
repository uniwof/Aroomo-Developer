import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { InboxService } from '../src/inbox/service.js';
import { InMemoryInboxStore } from '../src/inbox/store.js';
import { buildServer } from '../src/server.js';

describe('Inbox HTTP API Endpoints', () => {
  let app: FastifyInstance;
  let inboxService: InboxService;

  beforeEach(async () => {
    inboxService = new InboxService(new InMemoryInboxStore());
    const cfg = loadConfig({ LOG_LEVEL: 'silent' });
    app = buildServer(cfg, { inboxService });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/inbox/items - should list items and filter by group', async () => {
    await inboxService.createInboxItem({
      group: 'decision',
      kind: 'takeover',
      title: 'Decision 1',
      summary: 'Summary 1',
    });
    await inboxService.createInboxItem({
      group: 'candidate',
      kind: 'candidate_tool',
      title: 'Candidate 1',
      summary: 'Summary 2',
    });

    const resAll = await app.inject({
      method: 'GET',
      url: '/api/inbox/items',
    });
    expect(resAll.statusCode).toBe(200);
    const bodyAll = resAll.json();
    expect(bodyAll.items.length).toBe(2);

    const resFiltered = await app.inject({
      method: 'GET',
      url: '/api/inbox/items?group=decision',
    });
    expect(resFiltered.statusCode).toBe(200);
    const bodyFiltered = resFiltered.json();
    expect(bodyFiltered.items.length).toBe(1);
    expect(bodyFiltered.items[0].group).toBe('decision');
  });

  it('GET /api/inbox/unread-count - should return unread open items count', async () => {
    await inboxService.createInboxItem({
      group: 'decision',
      kind: 'k1',
      title: 'Title 1',
      summary: 'Summary 1',
    });
    await inboxService.createInboxItem({
      group: 'brief',
      kind: 'k2',
      title: 'Title 2',
      summary: 'Summary 2',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/inbox/unread-count',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 2 });
  });

  it('POST /api/inbox/items/:id/action - normal action, duplicate action (409), and irreversible two-step action', async () => {
    const item = await inboxService.createInboxItem({
      group: 'decision',
      kind: 'approval',
      title: 'Action Test',
      summary: 'Summary',
      actions: [
        { id: 'approve', label: 'Approve' },
        { id: 'delete', label: 'Delete Data', irreversible: true },
      ],
    });

    // 1. Normal action execution
    const res1 = await app.inject({
      method: 'POST',
      url: `/api/inbox/items/${item.id}/action`,
      payload: { actionId: 'approve' },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json();
    expect(body1.item.status).toBe('done');
    expect(body1.item.resolvedAction).toBe('approve');

    // 2. Duplicate execution -> 409 Conflict
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/inbox/items/${item.id}/action`,
      payload: { actionId: 'approve' },
    });
    expect(res2.statusCode).toBe(409);

    // 3. Irreversible action workflow
    const item2 = await inboxService.createInboxItem({
      group: 'decision',
      kind: 'approval2',
      title: 'Action Test 2',
      summary: 'Summary 2',
      actions: [{ id: 'delete', label: 'Delete Data', irreversible: true }],
    });

    // Step 1: Request without token -> 200 { needsConfirm: true, confirmToken: "..." }
    const resStep1 = await app.inject({
      method: 'POST',
      url: `/api/inbox/items/${item2.id}/action`,
      payload: { actionId: 'delete' },
    });
    expect(resStep1.statusCode).toBe(200);
    const bodyStep1 = resStep1.json();
    expect(bodyStep1.needsConfirm).toBe(true);
    expect(bodyStep1.confirmToken).toBeTruthy();

    // Step 2: Request with confirmToken
    const resStep2 = await app.inject({
      method: 'POST',
      url: `/api/inbox/items/${item2.id}/action`,
      payload: { actionId: 'delete', confirmToken: bodyStep1.confirmToken },
    });
    expect(resStep2.statusCode).toBe(200);
    const bodyStep2 = resStep2.json();
    expect(bodyStep2.item.status).toBe('done');
    expect(bodyStep2.item.resolvedAction).toBe('delete');
  });

  it('POST /api/inbox/items/:id/dismiss - dismiss single item', async () => {
    const item = await inboxService.createInboxItem({
      group: 'candidate',
      kind: 'tool',
      title: 'Tool Candidate',
      summary: 'Summary',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/inbox/items/${item.id}/dismiss`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.status).toBe('dismissed');
  });

  it('POST /api/inbox/batch-dismiss - batch dismiss items', async () => {
    await inboxService.createInboxItem({
      group: 'candidate',
      kind: 'tool1',
      title: 'Tool 1',
      summary: 'Summary 1',
    });
    await inboxService.createInboxItem({
      group: 'candidate',
      kind: 'tool2',
      title: 'Tool 2',
      summary: 'Summary 2',
    });
    await inboxService.createInboxItem({
      group: 'brief',
      kind: 'brief1',
      title: 'Brief 1',
      summary: 'Summary 3',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/inbox/batch-dismiss',
      payload: { group: 'candidate' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dismissedCount: 2 });

    const unreadRes = await app.inject({
      method: 'GET',
      url: '/api/inbox/unread-count',
    });
    expect(unreadRes.json()).toEqual({ count: 1 });
  });

  it('POST /api/inbox/items/:id/action - return 404 if item not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/inbox/items/non-existent/action',
      payload: { actionId: 'test' },
    });
    expect(res.statusCode).toBe(404);
  });
});
