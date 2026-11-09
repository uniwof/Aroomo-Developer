/**
 * 成员工具分配开关（docs/api/design-member-tools-v1.md）：要开只改这一行。单独一个文件、单独一个顶层常量（同 work-flag.ts）：
 * 关着时成员详情的「已分配的工具」和资源库的「算力（电脑助手）」入口都被摇掉，对话页包不涨；
 * 不放进 flags.ts，免得已有测试里整份 mock '@/lib/flags' 缺这一项。所有者看过界面点头再开。
 */
export const MEMBER_TOOLS = false;
