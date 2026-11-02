import { describe, expect, it } from 'vitest';
import { DriverBrowserPort } from '../src/agent/driver-session.js';
import { ModelPlanner, parseModelPlan } from '../src/agent/model-planner.js';
import { parseConfig } from '../src/config.js';
import type { BrowserDriver, DriverSession } from '../src/ports/driver.js';
import { Redactor } from '../src/redact.js';

const INPUT = { instruction: '点击登录按钮', snapshot: '@1 textbox "用户名"\n@2 textbox "密码"\n@3 button "登录"', availableFields: ['username', 'password'], round: 0 };

function stubFetch(reply: string | number, seen: string[] = []): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    seen.push(String(init?.body ?? ''));
    if (typeof reply === 'number') return new Response('err', { status: reply });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('模型规划器', () => {
  it('多轮规划：把前几轮已做动作（不含值）带给模型', async () => {
    const seen: string[] = [];
    const p = new ModelPlanner({ baseUrl: 'https://core.test', getToken: () => 't', fetchImpl: stubFetch('{"steps":[{"op":"done","note":"ok"}]}', seen) });
    await p.plan({ ...INPUT, round: 2, history: ['填写 username', '点击'] });
    expect(seen[0]).toContain('前几轮已做：填写 username；点击');
    await p.plan(INPUT);
    expect(seen[1]).not.toContain('前几轮已做');
  });


  it('解析模型输出的步骤', async () => {
    const p = new ModelPlanner({
      baseUrl: 'https://core.test',
      getToken: () => 't',
      fetchImpl: stubFetch('好的：{"steps":[{"op":"fill","ref":"@1","valueKey":"username"},{"op":"click","ref":"@3"}]}'),
    });
    expect(await p.plan(INPUT)).toEqual([
      { op: 'fill', ref: '@1', valueKey: 'username' },
      { op: 'click', ref: '@3' },
    ]);
    expect(p.lastFellBack).toBe(false);
  });

  it('模型乱编字段名 / 乱编引用 / 接口出错 → 退回规则规划器', async () => {
    for (const reply of ['{"steps":[{"op":"fill","ref":"@1","valueKey":"creditcard"}]}', '{"steps":[{"op":"click","ref":"@1\\"x"}]}', 500, '不是 JSON']) {
      const p = new ModelPlanner({ baseUrl: 'https://core.test', getToken: () => 't', fetchImpl: stubFetch(reply) });
      const steps = await p.plan(INPUT);
      expect(p.lastFellBack).toBe(true);
      expect(steps.at(-1)).toEqual({ op: 'click', ref: '@3' });
    }
  });

  it('parseModelPlan 校验', () => {
    expect(() => parseModelPlan('{"steps":[{"op":"rm -rf"}]}', [])).toThrow();
    expect(() => parseModelPlan('{"steps":[{"op":"click"}]}', [])).toThrow(/ref/);
    expect(parseModelPlan('{"steps":[{"op":"blocked","blocker":"weird"}]}', [])).toEqual([{ op: 'blocked', blocker: 'other' }]);
  });

  it('发给模型的内容：没有要填写的值，页面快照先脱敏', async () => {
    const SECRET = ['Very', 'Secret', 'Pw', '5512'].join('-');
    const EMAIL = 'baobao@example.com';
    const seen: string[] = [];
    let snap = `@1 textbox "邮箱" 当前值 ${EMAIL}\n@2 textbox "密码"\n@3 button "登录"`;
    const drv: DriverSession = {
      goto: async () => undefined,
      url: async () => 'https://example.com/login',
      title: async () => '',
      snapshot: async () => snap,
      click: async () => {
        snap = '@9 heading "欢迎"';
      },
      fill: async () => undefined,
      press: async () => undefined,
      screenshotInfo: async () => ({ width: 1, height: 1 }),
      handOff: async () => false,
      close: async () => undefined,
    };
    const driver: BrowserDriver = { name: 'stub', available: async () => true, open: async () => drv };
    const planner = new ModelPlanner({
      baseUrl: 'https://core.test',
      getToken: () => 't',
      fetchImpl: stubFetch('{"steps":[{"op":"fill","ref":"@1","valueKey":"email"},{"op":"fill","ref":"@2","valueKey":"password"},{"op":"click","ref":"@3"}]}', seen),
    });
    const r = new Redactor();
    r.add(EMAIL);
    r.add(SECRET);
    const s = await new DriverBrowserPort(driver, planner).open({ label: 't', redact: (t) => r.redact(t) });
    await s.fill([
      { target: 'email', value: EMAIL, sensitive: true },
      { target: 'password', value: SECRET, sensitive: true },
    ]);
    await s.act('点击登录按钮');
    expect(seen.length).toBeGreaterThan(0);
    const all = seen.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(EMAIL);
    expect(all).toContain('email, password');
  });
});

describe('规划器配置', () => {
  it('默认 model + aroomo/auto；可改 rule；非法值报错', () => {
    expect(parseConfig({}, '/d').planner).toEqual({ type: 'model', model: 'aroomo/auto' });
    expect(parseConfig({ planner: { type: 'rule' } }, '/d').planner.type).toBe('rule');
    expect(() => parseConfig({ planner: { type: 'gpt' } }, '/d')).toThrow();
  });
});
