import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTemplate, buildTemplate, listRecipes, removeSite } from '../src/tasks/recipe-templates.js';
import { findRecipe, loadRecipes } from '../src/tasks/recipes.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'rt-')), 'recipes.json');

describe('配方模板', () => {
  it('newapi 与 generic 都能通过配方校验，且只含字段名不含值', () => {
    for (const t of ['newapi', 'generic'] as const) {
      const rs = buildTemplate('https://HappyCoding.xyz/console/token', t);
      expect(rs.map((r) => r.kind).sort()).toEqual(['checkin', 'login']);
      expect(rs.every((r) => r.site === 'happycoding.xyz')).toBe(true);
      expect(JSON.stringify(rs)).not.toMatch(/\{\{|password":/);
    }
  });

  it('通配、手机应用不能套模板', () => {
    expect(() => buildTemplate('*.example.com')).toThrow(/具体的网站/);
    expect(() => buildTemplate('android-app://com.x.y')).toThrow();
  });

  it('add 写文件、再 add 同站点是替换不是重复，其他站点保留', () => {
    const f = file();
    addTemplate(f, 'a.example.com');
    addTemplate(f, 'b.example.com', 'generic');
    const again = addTemplate(f, 'a.example.com', 'generic');
    expect(again.total).toBe(4);
    const rs = loadRecipes(f);
    expect(findRecipe(rs, 'checkin', 'https://a.example.com/')?.id).toBe('a.example.com-checkin');
    expect(listRecipes(f)).toHaveLength(4);
  });

  it('remove 只删该站点；文件不存在时 list 为空；坏文件给出错误而不是覆盖', () => {
    const f = file();
    expect(listRecipes(f)).toEqual([]);
    addTemplate(f, 'a.example.com');
    addTemplate(f, 'b.example.com');
    expect(removeSite(f, 'a.example.com').removed).toHaveLength(2);
    expect(removeSite(f, 'a.example.com').removed).toEqual([]);
    expect(listRecipes(f).every((r) => r.site === 'b.example.com')).toBe(true);
    writeFileSync(f, '{"recipes":[{"id":"x"}]}');
    expect(() => addTemplate(f, 'c.example.com')).toThrow();
    expect(readFileSync(f, 'utf8')).toContain('"x"');
  });
});
