/**
 * Core 路由的类型（PRODUCT §9.4；DECISIONS D31 讨论模式）。
 *
 * 用户只面对两种模式：
 * - mention（点名）：输入里有 @ 就是点名，被 @ 的成员直接回答，负责人不介入；
 *   @ 多个成员时各自独立回答、并排显示；被点名成员故障时不自动换人，只给一行提示 +「交给负责人」。
 * - delegate（交给负责人）：没有 @ 时默认。负责人内部做法由 Core 选择，P0 只有 single（单人完成）。
 */

/** 路由只需要的成员视图；完整成员模型见 PRODUCT §12 Member（由后续 Issue 实现）。 */
export interface RoutableMember {
  id: string;
  /** 英文原名，例如 "Gemini 2.5 Pro"（PRODUCT §9.1 命名规则） */
  name: string;
  /** 可选别名，例如 "gemini" */
  aliases?: string[];
  /** 停用的成员不能被点名回答 */
  enabled: boolean;
  /**
   * 外部智能体成员（Poke、Webhook、Telegram、小桥等）。敏感项目的内容不发给外部方（D38），
   * 因此敏感项目里不能点名外部成员，外部智能体也不能作为负责人接手敏感任务。
   */
  external?: boolean;
}

export interface MentionParseResult {
  /** 识别到的成员 id，按首次出现顺序去重 */
  memberIds: string[];
  /** 输入里出现了 @xxx 但不对应任何成员 */
  unknown: string[];
  /** 去掉 @成员 之后的正文 */
  body: string;
  /** 输入里是否出现了点名意义上的 @（D31：有 @ 就是点名） */
  hasMention: boolean;
}

/** 负责人内部做法。P0 只实现 single；review/debate/compare 排在 P1（D31）。 */
export type LeadStrategy = 'single' | 'review' | 'debate' | 'compare';

export interface Hint {
  kind: 'hint';
  /** 一行提示，直接显示给用户 */
  text: string;
  memberId?: string;
  /** 「交给负责人」按钮；为空表示没有可用的补救动作（例如敏感项目的负责人是外部智能体） */
  actions: Array<{ id: 'delegate_to_lead'; label: '交给负责人' }>;
  /** 原问题正文：用户点「交给负责人」时原样交给负责人（delegateFromHint） */
  body?: string;
}

export interface MentionPlan {
  mode: 'mention';
  /** 每个目标独立、并行回答 */
  targets: string[];
  body: string;
  /** 不能回答的点名（未知名字、停用成员），各给一行提示 */
  hints: Hint[];
}

export interface DelegatePlan {
  mode: 'delegate';
  leadId: string | null;
  strategy: LeadStrategy;
  body: string;
  hints: Hint[];
}

export type RoutePlan = MentionPlan | DelegatePlan;

export interface RouteContext {
  members: RoutableMember[];
  /** 当前负责人；为 null 时由调用方提示用户先设置负责人 */
  leadId: string | null;
  /** 敏感项目（PRODUCT §9.6、D38）：不点名外部成员；负责人只用单人完成（D31） */
  sensitive?: boolean;
}
