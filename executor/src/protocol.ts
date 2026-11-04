/**
 * 与 Core 的协议类型（docs/executor-protocol.md）。改这里 = 改合同，两边一起改。
 */

export const TASK_KINDS = ['checkin', 'login', 'signup', 'browse'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TAKEOVER_REASONS = ['captcha', '2fa', 'payment', 'login_failed', 'not_allowed', 'other'] as const;
export type TakeoverReason = (typeof TAKEOVER_REASONS)[number];

export interface SecretRef {
  secretId: string;
  /** 字段名：username / password / email / phone / totp …（由 Core 保险箱定义） */
  field: string;
}

export interface Task {
  id: string;
  kind: TaskKind;
  /** 起点 URL，必须命中本机白名单 */
  site: string;
  instruction?: string;
  secrets?: SecretRef[];
  /** device=phone：在云手机 / 安卓上执行，site 写 android-app://<包名> */
  options?: { cloudOk?: boolean; markDisposable?: boolean; device?: 'pc' | 'phone' };
  createdAt: string;
  leaseExpiresAt: string;
}

/** 截图摘要：默认只传文字与哈希，不传图片本体（合同 3.2） */
export interface ScreenshotSummary {
  summary: string;
  width?: number;
  height?: number;
  sha256?: string;
}

export interface HelloRequest {
  deviceName: string;
  platform: string;
  version: string;
  adapters: string[];
  allowlistHash: string;
}

export interface HelloResponse {
  executorId: string;
  pollWaitSec: number;
  leaseSec: number;
  serverTime: string;
  minVersion?: string;
}

export interface ProgressRequest {
  seq: number;
  stage: string;
  message: string;
  screenshot?: ScreenshotSummary;
}

export interface ProgressResponse {
  leaseExpiresAt: string;
  cancel: boolean;
}

export interface TakeoverRequest {
  reason: TakeoverReason;
  message: string;
  screenshot?: ScreenshotSummary;
}

export type TakeoverStatus = 'pending' | 'resolved' | 'cancelled';

export interface TakeoverState {
  status: TakeoverStatus;
  note?: string;
}

export type ResultStatus = 'succeeded' | 'failed' | 'cancelled';

export interface ResultRequest {
  status: ResultStatus;
  summary: string;
  screenshot?: ScreenshotSummary;
  error?: { code: string; message: string };
}

/** Core 错误响应码中执行员需要区别处理的几个（合同第 5 节） */
export type CoreErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'TASK_NOT_FOUND' | 'LEASE_LOST' | 'SECRET_NOT_DECLARED' | string;
