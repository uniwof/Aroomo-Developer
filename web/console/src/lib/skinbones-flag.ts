/**
 * Skin/Bones 工作台骨架开关（Poke #250 补充规范「Bones」：核心四区 /chat、/work、/assets、/console + 常驻 224px 侧栏）。
 * 要开只改这一行。和 WORK 一样单独一个文件、单独一个顶层常量，因为构建器只内联顶层常量、不内联对象的属性（#323）：
 * 关着时四区侧栏和 /assets 的代码被摇掉，对话页包不涨；测试 mock '@/lib/flags' 时也不受影响。
 * 切片 1 只有骨架：/chat 照旧，/work（WORK 关着时）和 /assets 是一句话空状态 + 一个占位动作，/console 仍是现有驾驶舱。
 */
export const SKIN_BONES = false;
