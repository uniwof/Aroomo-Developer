// D215 计费预留：所有可能收费的功能都经 can(user, feature) 判断。现在一律允许。
export const FEATURES = ['chat', 'tool_call', 'executor_task', 'long_grant', 'catalog_submit'] as const;
export type Feature = (typeof FEATURES)[number];

export interface Plan {
  id: string;
  name: string;
  features: Record<Feature, { allowed: boolean; monthlyLimit: number | null }>;
}

export const FREE_PLAN: Plan = {
  id: 'free',
  name: '当前套餐（不限）',
  features: Object.fromEntries(FEATURES.map((f) => [f, { allowed: true, monthlyLimit: null }])) as Plan['features'],
};

export interface CanResult {
  allowed: boolean;
  plan: string;
}

export function planFor(_userId: string): Plan {
  return FREE_PLAN;
}

export function can(userId: string, feature: Feature): CanResult {
  if (!userId) return { allowed: false, plan: 'none' };
  const plan = planFor(userId);
  const rule = plan.features[feature];
  return { allowed: !!rule?.allowed, plan: plan.id };
}
