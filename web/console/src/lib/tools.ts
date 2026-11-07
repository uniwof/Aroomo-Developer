/** 工具网关工具的中文名和风险说明：资源库「工具」页和成员详情「已分配的工具」共用 */
export type ToolRisk = 'read' | 'write' | 'spend' | 'danger';
export const RISK_LABEL: Record<ToolRisk, string> = { read: '只读', write: '会改东西', spend: '花钱前先问你', danger: '做之前先问你' };
export const TOOL_NAME: Record<string, string> = { read_webpage: '读网页', browser_task_create: '派浏览器任务', browser_task_status: '查浏览器任务', browser_task_cancel: '取消浏览器任务' };
export const toolName = (name: string) => TOOL_NAME[name] ?? name;
