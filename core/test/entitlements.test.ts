import { describe, expect, it } from 'vitest';
import { can, FEATURES } from '../src/billing/entitlements.js';

describe('can(user, feature)', () => {
  it('allows every feature for any real user (billing reserved)', () => {
    for (const f of FEATURES) {
      expect(can('owner', f).allowed).toBe(true);
      expect(can('xiaohao', f).allowed).toBe(true);
    }
  });
  it('denies without a user', () => {
    expect(can('', 'chat').allowed).toBe(false);
  });
  it('denies unknown feature', () => {
    expect(can('u', 'nope' as never).allowed).toBe(false);
  });
});
