#!/usr/bin/env node
// 假的 `ego-browser nodejs`：从 stdin 读脚本，提供 taskSpace / page 的最小实现，状态存在 FAKE_EGO_STATE 文件里
// （模拟真实 ego lite「每次新进程、工作空间持久」的行为）。只用于合同测试。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const statePath = process.env.FAKE_EGO_STATE;
const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { nextId: 1, spaces: {} });
const save = (s) => writeFileSync(statePath, JSON.stringify(s));

const PAGES = {
  'https://example.com/login': '@1 textbox "用户名"\n@2 textbox "密码"\n@3 button "登录"',
  'https://example.com/home': '@1 heading "欢迎"\n@4 button "签到"',
  'https://example.com/captcha': '@1 heading "请完成人机验证"\n@2 button "提交"',
};

function makeTask(state, nameOrId) {
  let sp = Object.values(state.spaces).find((s) => s.id === nameOrId || s.name === nameOrId);
  if (!sp) {
    if (typeof nameOrId === 'number') throw Object.assign(new Error('no such space'), { code: 'EGO_NO_SPACE' });
    sp = { id: state.nextId++, name: nameOrId, url: 'about:blank', filled: {}, clicks: [], finished: false };
    state.spaces[sp.id] = sp;
  }
  if (sp.finished) throw Object.assign(new Error('space finished'), { code: 'EGO_FINISHED' });
  const page = {
    goto: async (url) => {
      sp.url = url;
    },
    url: async () => sp.url,
    title: async () => 'Fake',
    snapshot: async () => PAGES[sp.url] ?? '@1 heading "空白"',
    fill: async (ref, value) => {
      sp.filled[ref] = value.length; // 只记长度：假实现也不保存值
    },
    click: async (ref) => {
      sp.clicks.push(ref);
      if (sp.url === 'https://example.com/login' && ref === '@3') sp.url = 'https://example.com/home';
    },
    press: async () => {},
    evaluate: async () => ({ width: 1280, height: 800 }),
  };
  return {
    spaceId: sp.id,
    page: () => page,
    handOff: async () => {
      sp.handedOff = true;
    },
    finish: async () => {
      sp.finished = true;
    },
  };
}

const script = readFileSync(0, 'utf8');
const state = load();
globalThis.taskSpace = async (nameOrId) => makeTask(state, nameOrId);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
try {
  await new AsyncFunction(script)();
} finally {
  save(state);
}
