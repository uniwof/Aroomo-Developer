/** /work 项目与版本 v1（docs/api/design-work-v1.md）。切片 1：项目 + GitHub 公开仓库的 release / tag；切片 2：公共记忆版本、助手成功运行。 */
export type ProjectStatus = 'active' | 'paused' | 'done';
export const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'paused', 'done'];
export interface GithubSource {
  type: 'github';
  repo: string;
}
/** 本账号的一个公共记忆主题：每个版本（含当前版）是一个版本 */
export interface MemorySource {
  type: 'memory';
  topic: string;
}
/** 本账号的一个助手：每次成功的运行是一个版本 */
export interface AssistantSource {
  type: 'assistant';
  assistantId: string;
}
export type WorkSource = GithubSource | MemorySource | AssistantSource;
export const MAX_SOURCES = 5;
/** 一个账号最多几个项目。shortcut: 项目列表不分页（最多 200 个），真有人超过再给列表加游标 */
export const MAX_PROJECTS = 200;
/** 同一个项目两次同步至少隔多久（不带令牌每小时 60 次、按出口 IP 算，staging 和生产同机共用） */
export const SYNC_INTERVAL_MS = 10 * 60 * 1000;

export interface WorkProject {
  id: string;
  userId: string;
  name: string;
  status: ProjectStatus;
  sources: WorkSource[];
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SourceType = 'github_release' | 'github_tag' | 'memory' | 'assistant_run';
export type SourceState = 'published' | 'prerelease' | 'tagged' | 'none';
export interface Artifact {
  type: 'page' | 'file';
  title: string;
  /** null = 来源给的链接不在 GitHub 主机白名单里（或不是 https），界面写「链接不可用」 */
  url: string | null;
  size: number | null;
}
/** 产出者：GitHub 的作者，或产出这次运行的助手（名字是同步那一刻的）。公共记忆没有作者 = null */
export type Actor = { type: 'github'; name: string } | { type: 'assistant'; name: string; id: string };

/** 同步得到的一个版本（还没落库） */
export interface VersionInput {
  sourceType: SourceType;
  sourceRef: string;
  label: string;
  title: string | null;
  actor: Actor | null;
  artifacts: Artifact[];
  sourceState: SourceState;
  sourceAt: Date | null;
}
export interface WorkVersion extends VersionInput {
  id: string;
  userId: string;
  projectId: string;
  syncedAt: Date;
  /** 写入先后（库里自增）：排序时间相同时按它，新的大 */
  seq: number;
}

export const VERSION_PAGE = 30;
/** 每个账号每小时最多同步几次（负责人 #323 建议：一次同步最多 5 来源 × 6 页 = 30 次请求，不带令牌每小时 60 次按出口 IP 算） */
export const SYNC_PER_HOUR = 3;
