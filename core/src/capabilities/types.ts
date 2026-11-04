/** 能力清单（M1 第一版）：种子数据来自资源清单，不含 Key。 */
export type CapabilityKind = 'text' | 'image' | 'video';
/** free = 永久免费；trial = 试用/限时/一次性额度；paid = 付费 */
export type CapabilityAccess = 'free' | 'trial' | 'paid';
/** ready 可用 · unverified 已填未验证 · failed 验证失败（只标状态，不自动注册）· missing 未填 · keyless 免 Key */
export type CapabilityStatus = 'ready' | 'unverified' | 'failed' | 'missing' | 'keyless';

export interface CapabilityQuota {
  /** 已用；查不到为 null，界面显示「未知」 */
  used: number | null;
  limit: number | null;
  unit: string;
  resets?: string;
}

export interface CapabilityItem {
  id: string;
  name: string;
  kind: CapabilityKind;
  provider: string;
  access: CapabilityAccess;
  status: CapabilityStatus;
  quota: CapabilityQuota | null;
  note: string | null;
}

export interface CapabilityTool {
  id: string;
  name: string;
  group: string;
  access: CapabilityAccess;
  status: CapabilityStatus;
  quota: CapabilityQuota | null;
  note: string | null;
}

export interface LibraryGroup {
  name: string;
  count: number;
}

export interface CapabilitySeed {
  source: string;
  items: CapabilityItem[];
  tools: CapabilityTool[];
  library: { skills: { total: number; groups: LibraryGroup[] }; resources: { total: number; groups: LibraryGroup[] } };
}
