/**
 * 账号的 Key 在 LiteLLM 里的命名空间（D117-19）：部署名 = u<32 位十六进制>/<模型名>。
 * 前缀与 settings 的 scopedSettings 一致；所有者（'owner'）不加前缀，保持既有部署可用。
 * Core 只会在「这个账号自己的请求」里把成员名换成带前缀的名字，所以别人的请求叫不到它。
 */
export function userPrefix(userId: string): string {
  const hex = userId.toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!/^[a-f0-9]{32}$/.test(hex)) throw new Error('非法 user id');
  return `u${hex}`;
}

/** 范围 → 上游模型名映射；'owner' = 原名。 */
export function upstreamNameFor(scope: string): (name: string) => string {
  if (scope === 'owner') return (n) => n;
  const prefix = userPrefix(scope);
  return (n) => `${prefix}/${n}`;
}
