/**
 * D208 基线：当前没声明 capability / clientScope / clientSelf 的 /api 路由。
 * 它们靠「默认拒绝」只给所有者（账号、操作员、客户端令牌都被 onRequest 钩子拒绝，见 authz.test.ts）。
 * 只许删，不许加：新路由必须声明权限，否则 CI 失败。
 */
export const OWNER_ONLY_BASELINE: string[] = [
  'DELETE /api/clients/:id',
  'DELETE /api/library/:id',
  'DELETE /api/memory/:topic',
  'DELETE /api/vault/:id',
  'GET /api/auth/me',
  'GET /api/clients',
  'GET /api/executor-allowlist',
  'GET /api/executors',
  'GET /api/memory/:topic/versions',
  'GET /api/tasks',
  'GET /api/tasks/:id',
  'GET /api/tasks/:id/takeovers',
  'GET /api/users',
  'GET /api/vault',
  'POST /api/auth/logout',
  'POST /api/auth/logout-all',
  'POST /api/auth/password',
  'POST /api/clients',
  'POST /api/clients/revoke-all',
  'POST /api/memory/:topic/rollback',
  'POST /api/tasks',
  'POST /api/tasks/:id/cancel',
  'POST /api/tasks/:id/takeovers/:tid/resolve',
  'POST /api/users/:id/disable',
  'POST /api/users/:id/enable',
  'POST /api/users/:id/reset-link',
  'POST /api/users/invites',
  'POST /api/vault',
  'POST /api/vault/:id/reveal',
  'PUT /api/executor-allowlist',
  'PUT /api/memory/:topic',
  'PUT /api/vault/:id',
];
