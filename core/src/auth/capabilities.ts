/**
 * 能力清单与操作员白名单（DECISIONS D36：操作员令牌权限改为白名单，默认拒绝）。
 *
 * - 主人（owner，P0 单用户）拥有全部能力。
 * - 操作员（operator，外部智能体负责人用的令牌）只能用 OPERATOR_WHITELIST 里的能力，
 *   且还要在自己令牌的授权范围内（两者取交集）。
 * - PRODUCT §9.3 原黑名单作为「白名单里不得包含」的参考：不能查看或导出 Key、不能删除、
 *   不能确认付费/不可逆操作、不能改总令牌、不能新建引用密钥的成员。
 *   因此 keys:*、*:purge、*:delete、inbox:confirm-irreversible、audit:read 都不进白名单。
 */

export const CAPABILITIES = [
  'audit:read',
  'members:read',
  'members:write',
  'members:delete',
  'members:purge',
  'inbox:read',
  'inbox:act',
  'inbox:confirm-irreversible',
  'keys:read',
  'keys:write',
  'keys:delete',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** 操作员最多能被授予的能力。新增能力默认不在这里；加进来需要负责人确认。 */
export const OPERATOR_WHITELIST: ReadonlySet<Capability> = new Set<Capability>([
  'members:read',
  'inbox:read',
  'inbox:act',
]);

export function isCapability(v: string): v is Capability {
  return (CAPABILITIES as readonly string[]).includes(v);
}
