#!/usr/bin/env node
// 假的 Playwright MCP 服务（stdio JSON-RPC），响应格式仿照 @playwright/mcp 0.0.x 的文本输出。只用于合同测试。
import { createInterface } from 'node:readline';

const PAGES = {
  'https://example.com/login': '- textbox "用户名" [ref=e1]\n- textbox "密码" [ref=e2]\n- button "登录" [ref=e3]',
  'https://example.com/home': '- heading "欢迎" [level=1] [ref=e1]\n- button "签到" [ref=e4]',
  'https://example.com/captcha': '- heading "请完成人机验证" [ref=e1]\n- button "提交" [ref=e2]',
};
let url = 'about:blank';
const typedLens = [];

const state = () =>
  `### Page state\n- Page URL: ${url}\n- Page Title: Fake\n- Page Snapshot:\n\`\`\`yaml\n${PAGES[url] ?? '- heading "空白" [ref=e1]'}\n\`\`\``;
const text = (t) => ({ content: [{ type: 'text', text: t }] });

function call(name, a) {
  switch (name) {
    case 'browser_navigate':
      url = a.url;
      return text(`### Ran Playwright code\nawait page.goto('${a.url}');\n${state()}`);
    case 'browser_snapshot':
      return text(state());
    case 'browser_type':
      typedLens.push(a.text.length);
      // 真实服务会回显代码（含值）——客户端不得记录
      return text(`### Ran Playwright code\nawait page.getByRole('textbox').fill('${a.text}');\n${state()}`);
    case 'browser_click':
      if (url === 'https://example.com/login' && a.target === 'e3') url = 'https://example.com/home';
      return text(`### Ran Playwright code\nawait page.click();\n${state()}`);
    case 'browser_press_key':
      return text('ok');
    case 'browser_evaluate':
      return text('### Result\n{"width":1280,"height":800}');
    case 'browser_take_screenshot':
      return { content: [{ type: 'image', data: Buffer.from('fake-png-' + url).toString('base64'), mimeType: 'image/png' }] };
    case 'browser_close':
      return text('closed');
    default:
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-pw', version: '0' } };
  else if (m.method === 'tools/call') result = call(m.params.name, m.params.arguments ?? {});
  else return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no method' } }) + '\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
});
