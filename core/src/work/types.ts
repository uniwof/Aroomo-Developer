/** /work 项目与版本 v1（docs/api/design-work-v1.md）。切片 1：项目 + GitHub 公开仓库的 release / tag。 */
export type ProjectStatus = 'active' | 'paused' | 'done';
export const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'paused', 'done'];
/** 切片 1 只有 GitHub 公开仓库；切片 3 加公共记忆、助手 */
export interface GithubSource {
  type: 'github';
  repo: string;
}
export type WorkSource = GithubSource;
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

export type SourceType = 'github_release' | 'github_tag';
export type SourceState = 'published' | 'prerelease' | 'tagged' | 'none';
export interface Artifact {
  type: 'page' | 'file';
  title: string;
  /** null = 来源给的链接不在 GitHub 主机白名单里（或不是 https），界面写「链接不可用」 */
  url: string | null;
  size: number | null;
}
export interface Actor {
  type: 'github';
  name: string;
}

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
}

export const VERSION_PAGE = 30;
