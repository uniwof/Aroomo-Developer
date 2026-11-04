/**
 * 能力清单、操作员白名单与禁止清单（DECISIONS D62；取代 D36 时期的暂定白名单）。
 *
 * - 主人（owner，P0 单用户）拥有全部能力。
 * - 操作员（operator，外部智能体负责人用的令牌）只能用 OPERATOR_WHITELIST 里的能力，
 *   且还要在自己令牌的授权范围内（两者取交集）。
 * - OPERATOR_DENYLIST 是 D62「禁止」项的逐条对应：这些能力永远不能进白名单，
 *   模块加载时校验两张表没有交集（assertOperatorPolicy），有交集直接启动失败。
 * - 白名单以外的请求（含没有声明能力的接口、不存在的接口）一律拒绝并写审计（auth/plugin.ts）。
 */

export const CAPABILITIES = [
  // —— D62 允许项 ——
  /** 执行分配给自己的任务并提交结果（任务模块尚未实现，先占位，接口上线时用它鉴权） */
  'tasks:execute-own',
  /** 向收件箱发卡片（POST /api/inbox） */
  'inbox:post',
  /** 在白名单网站代办注册和登录；验证码、两步验证、付款交给用户接管（网页代办模块尚未实现） */
  'webagent:signup-login',
  /** 读取完成任务所需的成员信息（成员接口本来就不含 Key 明文） */
  'members:read',

  // —— 只有主人能用的普通能力 ——
  'audit:read',
  'members:write',
  'inbox:read',
  'inbox:act',
  'keys:read',
  'keys:write',
  /** 修改普通设置（P0：负责人） */
  'settings:write',

  // —— D62 禁止项（操作员永远不能拥有）——
  /** 读取 Key 明文（Core 本身没有这样的接口；能力名占位，保证将来也不能授予操作员） */
  'keys:read-plaintext',
  'keys:export',
  'backups:read',
  'backups:export',
  /** 修改权限（含操作员令牌的能力范围） */
  'permissions:write',
  /** 修改敏感保护设置 */
  'settings:sensitive:write',
  /** 修改官方域名表（D37） */
  'official-domains:write',
  /** 不可逆：删除 */
  'members:delete',
  'members:purge',
  /** 不可逆：删除 / 作废 Key */
  'keys:delete',
  'keys:revoke',
  /** 不可逆：取消试用 */
  'trial:cancel',
  /** 付款或添加付款方式 */
  'payments:pay',
  'payments:add-method',
  /** 修改或删除审计日志（审计本来就只追加，这里再加一道） */
  'audit:write',
  'audit:delete',
  /** 签发操作员令牌 */
  'operator-tokens:issue',
  /** 完成「重要确认」（不可逆、花钱、涉及凭据，D63）——只能由主人本人点 */
  'confirm:important',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** D62 允许项：操作员最多能被授予的能力。加新项需要负责人裁决。 */
export const OPERATOR_WHITELIST: ReadonlySet<Capability> = new Set<Capability>([
  'tasks:execute-own',
  'inbox:post',
  'webagent:signup-login',
  'members:read',
]);

/** D62 禁止项：无论令牌里写了什么、白名单将来怎么改，操作员都不能拥有。 */
export const OPERATOR_DENYLIST: ReadonlySet<Capability> = new Set<Capability>([
  'keys:read-plaintext',
  'keys:export',
  'backups:read',
  'backups:export',
  'permissions:write',
  'settings:sensitive:write',
  'official-domains:write',
  'members:delete',
  'members:purge',
  'keys:delete',
  'keys:revoke',
  'trial:cancel',
  'payments:pay',
  'payments:add-method',
  'audit:write',
  'audit:delete',
  'operator-tokens:issue',
  'confirm:important',
]);

export function isCapability(v: string): v is Capability {
  return (CAPABILITIES as readonly string[]).includes(v);
}

/** 操作员能否拥有某能力：在白名单里，且不在禁止清单里。 */
export function operatorMayHave(cap: Capability): boolean {
  return OPERATOR_WHITELIST.has(cap) && !OPERATOR_DENYLIST.has(cap);
}

/** 白名单与禁止清单不得有交集（D62）。 */
export function assertOperatorPolicy(
  whitelist: ReadonlySet<Capability> = OPERATOR_WHITELIST,
  denylist: ReadonlySet<Capability> = OPERATOR_DENYLIST,
): void {
  const overlap = [...whitelist].filter((c) => denylist.has(c));
  if (overlap.length > 0) throw new Error(`操作员白名单包含禁止项：${overlap.join(', ')}（DECISIONS D62）`);
}

assertOperatorPolicy();
