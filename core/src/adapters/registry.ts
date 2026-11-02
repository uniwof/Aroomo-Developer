/** 适配器注册表：网关按工具名找适配器。后台线在 index.ts 里一行引入。 */
import type { ToolAdapter, ToolRisk, ToolSpec } from './types.js';

export class AdapterRegistry {
  #byTool = new Map<string, ToolAdapter>();

  add(a: ToolAdapter): this {
    for (const t of a.tools()) {
      if (this.#byTool.has(t.name)) throw new Error(`工具名重复：${t.name}`);
      this.#byTool.set(t.name, a);
    }
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
