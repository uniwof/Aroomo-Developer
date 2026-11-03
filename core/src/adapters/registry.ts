/** 适配器注册表：网关按工具名找适配器。后台线在 index.ts 里一行引入。 */
import type { ToolAdapter, ToolRisk, ToolSpec } from './types.js';

export class AdapterRegistry {
  #byTool = new Map<string, ToolAdapter>();

  /** 先查完这一批所有名字（与已登记的、与本批内部）都不重复，再一起登记；有一个重复就整批不登记（#246） */
  add(a: ToolAdapter): this {
    const names = a.tools().map((t) => t.name);
    const seen = new Set<string>();
    for (const n of names) {
      if (this.#byTool.has(n) || seen.has(n)) throw new Error(`工具名重复：${n}`);
      seen.add(n);
    }
    for (const n of names) this.#byTool.set(n, a);
    return this;
  }

  tools(): ToolSpec[] {
    return [...this.#byTool.entries()].flatMap(([name, a]) => a.tools().filter((t) => t.name === name));
  }

  find(tool: string): ToolAdapter | undefined {
    return this.#byTool.get(tool);
  }

  riskOf(tool: string, args: Record<string, unknown>): ToolRisk | null {
    const a = this.#byTool.get(tool);
    if (!a) return null;
    if (a.riskOf) return a.riskOf(tool, args);
    return a.tools().find((t) => t.name === tool)?.risk ?? null;
  }
}
