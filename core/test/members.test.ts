import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MemberService } from '../src/members/service.js';
import { InMemoryMemberStore } from '../src/members/store.js';
import type { AuditFn, CapabilityTag, Member } from '../src/members/types.js';
import { buildServer } from '../src/server.js';

describe('Member Store & Service Unit Tests', () => {
  it('validates id format [a-z0-9-]', async () => {
    const store = new InMemoryMemberStore();
    const service = new MemberService({ store });

    await expect(
      service.create({ id: 'Invalid_ID', name: 'Claude' }),
    ).rejects.toThrow('Invalid member id');

    await expect(
      service.create({ id: 'claude_3', name: 'Claude' }),
    ).rejects.toThrow('Invalid member id');

    const created = await service.create({ id: 'claude-3-5-sonnet', name: 'Claude Sonnet' });
    expect(created.id).toEqual('claude-3-5-sonnet');
  });

  it('validates capabilityTags and empty name', async () => {
    const store = new InMemoryMemberStore();
    const service = new MemberService({ store });

    await expect(
      service.create({ id: 'm1', name: '' }),
    ).rejects.toThrow('Member name cannot be empty');

    await expect(
      service.create({ id: 'm1', name: 'M1', capabilityTags: ['invalid-tag' as CapabilityTag] }),
    ).rejects.toThrow('Invalid capabilityTag');
  });

  it('prevents duplicate names (case-insensitive)', async () => {
    const store = new InMemoryMemberStore();
    const service = new MemberService({ store });

    await service.create({ id: 'gpt-4o', name: 'GPT-4o' });

    await expect(
      service.create({ id: 'gpt-4o-2', name: 'gpt-4o' }),
    ).rejects.toThrow('already exists');

    // Updating to duplicate name
    await service.create({ id: 'claude-3', name: 'Claude 3' });
    await expect(
      service.update('claude-3', { name: 'gpt-4O' }),
    ).rejects.toThrow('already exists');
  });

  it('handles pin and sortOrder rules correctly', async () => {
    const store = new InMemoryMemberStore();
    const service = new MemberService({ store });

    await service.create({ id: 'm1', name: 'Member 1', sortOrder: 10 });
    await service.create({ id: 'm2', name: 'Member 2', sortOrder: 1 });
    await service.create({ id: 'm3', name: 'Member 3', sortOrder: 5 });

    const list = await service.list();
    expect(list.map((m) => m.id)).toEqual(['m2', 'm3', 'm1']);

    await service.setPinned('m3', true);
    const updatedList = await service.list();
    // Pinned comes first
    expect(updatedList.map((m) => m.id)).toEqual(['m3', 'm2', 'm1']);
  });

  it('atomically reorders members and validates ID set equality', async () => {
    const store = new InMemoryMemberStore();
    const service = new MemberService({ store });

    await service.create({ id: 'a', name: 'A' });
    await service.create({ id: 'b', name: 'B' });
    await service.create({ id: 'c', name: 'C' });

    // Missing ID
    await expect(service.reorder(['a', 'b'])).rejects.toThrow('count does not match');

    // Invalid / Unknown ID
    await expect(service.reorder(['a', 'b', 'unknown'])).rejects.toThrow('not an active member');

    // Duplicate ID
    await expect(service.reorder(['a', 'b', 'b'])).rejects.toThrow('duplicates');

    // Valid reorder
    const reordered = await service.reorder(['c', 'a', 'b']);
    expect(reordered.map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect(reordered.map((m) => m.sortOrder)).toEqual([0, 1, 2]);
  });

  it('handles soft delete, restore, and 30-day recycle bin expiry (with time injection)', async () => {
    let mockTime = new Date('2026-01-01T00:00:00Z');
    const getNow = () => mockTime;

    const store = new InMemoryMemberStore({ getNow });
    const auditMock = vi.fn();
    const service = new MemberService({ store, audit: auditMock as AuditFn });

    await service.create({ id: 'm1', name: 'Member 1' });
    await service.softDelete('m1');

    const initialList = await service.list();
    expect(initialList).toHaveLength(0);

    let listWithDeleted = await service.list({ includeDeleted: true });
    expect(listWithDeleted).toHaveLength(1);

    // Fast forward 29 days
    mockTime = new Date('2026-01-30T00:00:00Z');
    listWithDeleted = await service.list({ includeDeleted: true });
    expect(listWithDeleted).toHaveLength(1);

    // Can restore at 29 days
    const restored = await service.restore('m1');
    expect(restored.id).toEqual('m1');

    // Delete again
    await service.softDelete('m1');

    // Fast forward 31 days from deletion time
    mockTime = new Date('2026-03-05T00:00:00Z');

    // Expired item hidden from trash and cannot be restored
    listWithDeleted = await service.list({ includeDeleted: true });
    expect(listWithDeleted).toHaveLength(0);

    await expect(service.restore('m1')).rejects.toThrow('deleted over 30 days ago');
  });

  it('triggers audit callbacks for write operations', async () => {
    const store = new InMemoryMemberStore();
    const auditMock = vi.fn();
    const service = new MemberService({ store, audit: auditMock });

    await service.create({ id: 'm1', name: 'Member 1' });
    expect(auditMock).toHaveBeenCalledWith('member.create', 'm1', 'success', expect.any(Object));

    await service.update('m1', { aliases: ['m1-alias'] });
    expect(auditMock).toHaveBeenCalledWith('member.update', 'm1', 'success', expect.any(Object));

    await service.setPinned('m1', true);
    expect(auditMock).toHaveBeenCalledWith('member.pin', 'm1', 'success', expect.any(Object));

    await service.softDelete('m1');
    expect(auditMock).toHaveBeenCalledWith('member.delete', 'm1', 'success', undefined);

    await service.restore('m1');
    expect(auditMock).toHaveBeenCalledWith('member.restore', 'm1', 'success', undefined);

    await service.purge('m1', true);
    expect(auditMock).toHaveBeenCalledWith('member.purge', 'm1', 'success', undefined);
  });
});

describe('Member HTTP API Tests (fastify.inject)', () => {
  const cfg = loadConfig({ LOG_LEVEL: 'silent' });

  it('covers GET /api/members (list)', async () => {
    const store = new InMemoryMemberStore();
    const app = buildServer(cfg, { memberStore: store });

    await store.create({ id: 'm1', name: 'M1' });

    const res = await app.inject({ method: 'GET', url: '/api/members' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].id).toBe('m1');
  });

  it('covers POST /api/members (create) and 400/409 responses', async () => {
    const store = new InMemoryMemberStore();
    const app = buildServer(cfg, { memberStore: store });

    // Valid create -> 201
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: {
        id: 'claude-3-5',
        name: 'Claude 3.5 Sonnet',
        aliases: ['claude'],
        capabilityTags: ['text', 'code'],
      },
    });
    expect(res1.statusCode).toBe(201);
    expect(res1.json().member.id).toBe('claude-3-5');

    // Duplicate ID -> 409
    const resDupId = await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: { id: 'claude-3-5', name: 'Other Name' },
    });
    expect(resDupId.statusCode).toBe(409);

    // Duplicate Name -> 409
    const resDupName = await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: { id: 'claude-3-5-v2', name: 'claude 3.5 sonnet' },
    });
    expect(resDupName.statusCode).toBe(409);

    // Invalid Tag -> 400
    const resBadTag = await app.inject({
      method: 'POST',
      url: '/api/members',
      payload: { id: 'bad-tag', name: 'Bad Tag', capabilityTags: ['invalid'] },
    });
    expect(resBadTag.statusCode).toBe(400);
  });

  it('covers GET, PUT, PATCH /api/members/:id', async () => {
    const store = new InMemoryMemberStore();
    const app = buildServer(cfg, { memberStore: store });

    await store.create({ id: 'm1', name: 'Member 1' });

    // GET
    const resGet = await app.inject({ method: 'GET', url: '/api/members/m1' });
    expect(resGet.statusCode).toBe(200);
    expect(resGet.json().member.name).toBe('Member 1');

    // PUT
    const resPut = await app.inject({
      method: 'PUT',
      url: '/api/members/m1',
      payload: { name: 'Member 1 Updated' },
    });
    expect(resPut.statusCode).toBe(200);
    expect(resPut.json().member.name).toBe('Member 1 Updated');

    // PATCH
    const resPatch = await app.inject({
      method: 'PATCH',
      url: '/api/members/m1',
      payload: { enabled: false },
    });
    expect(resPatch.statusCode).toBe(200);
    expect(resPatch.json().member.enabled).toBe(false);

    // GET non-existent -> 404
    const res404 = await app.inject({ method: 'GET', url: '/api/members/non-existent' });
    expect(res404.statusCode).toBe(404);
  });

  it('covers DELETE (soft), POST /restore, and hard delete (confirm requirement -> 409 without confirm)', async () => {
    const store = new InMemoryMemberStore();
    const app = buildServer(cfg, { memberStore: store });

    await store.create({ id: 'm1', name: 'M1' });

    // Soft delete
    const resDel = await app.inject({ method: 'DELETE', url: '/api/members/m1' });
    expect(resDel.statusCode).toBe(200);
    expect(resDel.json().member.deletedAt).not.toBeNull();

    // Restore
    const resRestore = await app.inject({ method: 'POST', url: '/api/members/m1/restore' });
    expect(resRestore.statusCode).toBe(200);
    expect(resRestore.json().member.deletedAt).toBeNull();

    // Purge without confirm -> 409
    const resPurgeNoConfirm = await app.inject({
      method: 'POST',
      url: '/api/members/m1/purge',
      payload: {},
    });
    expect(resPurgeNoConfirm.statusCode).toBe(409);

    // Purge with confirm: false -> 409
    const resPurgeConfirmFalse = await app.inject({
      method: 'POST',
      url: '/api/members/m1/purge',
      payload: { confirm: false },
    });
    expect(resPurgeConfirmFalse.statusCode).toBe(409);

    // Purge with confirm: true -> 200
    const resPurgeOk = await app.inject({
      method: 'POST',
      url: '/api/members/m1/purge',
      payload: { confirm: true },
    });
    expect(resPurgeOk.statusCode).toBe(200);

    // Ensure purged
    const resGetAfterPurge = await app.inject({ method: 'GET', url: '/api/members/m1' });
    expect(resGetAfterPurge.statusCode).toBe(404);
  });

  it('covers POST /api/members/:id/pin & /unpin', async () => {
    const store = new InMemoryMemberStore();
    const app = buildServer(cfg, { memberStore: store });

    await store.create({ id: 'm1', name: 'M1' });

    // Pin
    const resPin = await app.inject({ method: 'POST', url: '/api/members/m1/pin' });
    expect(resPin.statusCode).toBe(200);
    expect(resPin.json().member.pinned).toBe(true);

    // Unpin
    const resUnpin = await app.inject({ method: 'POST', url: '/api/members/m1/unpin' });
    expect(resUnpin.statusCode).toBe(200);
    expect(resUnpin.json().member.pinned).toBe(false);
  });

  it('covers POST /api/members/reorder', async () => {
    const store = new InMemoryMemberStore();
    const app = buildServer(cfg, { memberStore: store });

    await store.create({ id: 'a', name: 'A' });
    await store.create({ id: 'b', name: 'B' });

    // Invalid reorder -> 400
    const resInvalid = await app.inject({
      method: 'POST',
      url: '/api/members/reorder',
      payload: { ids: ['a'] },
    });
    expect(resInvalid.statusCode).toBe(400);

    // Valid reorder -> 200
    const resValid = await app.inject({
      method: 'POST',
      url: '/api/members/reorder',
      payload: { ids: ['b', 'a'] },
    });
    expect(resValid.statusCode).toBe(200);
    expect(resValid.json().members.map((m: Member) => m.id)).toEqual(['b', 'a']);
  });
});
