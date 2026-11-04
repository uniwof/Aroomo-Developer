/**
 * 朗读回复（负责人审查点 1 补充裁决 2）：只用浏览器自带的语音合成（speechSynthesis），不加依赖。
 * - 默认只用本机中文语音（voice.localService === true）。Chrome / Edge 的「在线 / 自然」语音会把文字发到
 *   Google 或微软去合成，只有所有者点了「用在线语音」才用（家人账号上线前要复核这一条）。
 * - 只读纯文字：去掉 Markdown 符号；代码块读成「这里有一段代码，已略过」；链接只读文字，网址不读；署名照读。
 * - 长回复按句号、问号、换行切成小段，一段读完再读下一段（避免 Chrome 读十几秒自己停下）。
 * - 同一时间只读一条；切换会话、开始新回复、离开页面时由调用方 stop()。
 * - 第一版只有点了才读，不自动朗读。
 */

export const CODE_SKIPPED = '这里有一段代码，已略过。';
export const SPEECH_RATES = [0.8, 1, 1.2, 1.5] as const;
export const DEFAULT_RATE = 1;
const MAX_CHUNK = 120;

export const speechSupported = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function';

/** Markdown → 适合朗读的纯文字 */
export function speakableText(md: string): string {
  let t = md.replace(/\r\n/g, '\n');
  // 代码块（``` 或 ~~~ 围起来的，没收尾也算）
  t = t.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, `$1${CODE_SKIPPED}\n`);
  // 图片：只读替代文字
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 链接：只读链接文字
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  // 引用式链接的定义行、自动链接、裸网址：都不读
  t = t.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '');
  t = t.replace(/<(?:https?:\/\/|mailto:|www\.)[^>]*>/gi, '');
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>()（）]+/gi, '');
  // 行内代码：留下内容
  t = t.replace(/`([^`]*)`/g, '$1');
  // HTML 标签
  t = t.replace(/<\/?[a-z][^>]*>/gi, '');
  // 标题、引用、列表符号、分隔线、表格竖线
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  t = t.replace(/^[ \t]*>+[ \t]?/gm, '');
  t = t.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '');
  t = t.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  t = t.replace(/^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/gm, '');
  t = t.replace(/\|/g, ' ');
  // 强调符号
  t = t.replace(/(\*\*|__|\*|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  // 空白收拢
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n');
  return t.trim();
}

/** 切成小段：按句号、问号、感叹号、分号、换行切；单句太长再按逗号或长度切 */
export function splitForSpeech(text: string, max = MAX_CHUNK): string[] {
  const out: string[] = [];
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;]*|\n/g) ?? [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= max) {
      out.push(s);
      continue;
    }
    let rest = s;
    while (rest.length > max) {
      const cut = Math.max(rest.lastIndexOf('，', max), rest.lastIndexOf(',', max), rest.lastIndexOf(' ', max));
      const at = cut > max / 3 ? cut + 1 : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at);
    }
    if (rest.trim()) out.push(rest.trim());
  }
  return out;
}

const isZh = (v: SpeechSynthesisVoice) => /^(zh|cmn|yue)\b/i.test(v.lang.replace('_', '-'));

export type VoicePlan = { kind: 'local'; voice: SpeechSynthesisVoice } | { kind: 'online'; voice: SpeechSynthesisVoice | null };

/**
 * 选语音：有本机中文语音就用它；没有时，只有允许在线语音才用在线中文语音（没有就交给浏览器按 zh-CN 选）。
 * 返回 null = 本机没有中文语音、又没允许在线语音（按钮显示「用在线语音」，点了才读）。
 */
export function pickVoice(voices: readonly SpeechSynthesisVoice[], allowOnline: boolean): VoicePlan | null {
  const zh = voices.filter(isZh);
  const local = zh.find((v) => v.localService === true && /^zh[-_]CN/i.test(v.lang)) ?? zh.find((v) => v.localService === true);
  if (local) return { kind: 'local', voice: local };
  if (!allowOnline) return null;
  return { kind: 'online', voice: zh.find((v) => /^zh[-_]CN/i.test(v.lang)) ?? zh[0] ?? null };
}

type Listener = (speakingId: string | null) => void;

/** 全页只有一个朗读器：同一时间只读一条 */
class Speaker {
  #id: string | null = null;
  #token = 0;
  readonly #listeners = new Set<Listener>();

  get speakingId(): string | null {
    return this.#id;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(id: string | null) {
    this.#id = id;
    for (const fn of this.#listeners) fn(id);
  }

  /** 读一条回复：先停掉正在读的，再一段一段读 */
  speak(id: string, markdown: string, opts: { rate: number; plan: VoicePlan }): boolean {
    if (!speechSupported()) return false;
    const chunks = splitForSpeech(speakableText(markdown));
    this.stop();
    if (!chunks.length) return false;
    const token = ++this.#token;
    const synth = window.speechSynthesis;
    let i = 0;
    const next = () => {
      if (token !== this.#token) return;
      if (i >= chunks.length) {
        this.#set(null);
        return;
      }
      const u = new window.SpeechSynthesisUtterance(chunks[i++]!);
      u.lang = opts.plan.voice?.lang ?? 'zh-CN';
      if (opts.plan.voice) u.voice = opts.plan.voice;
      u.rate = Math.min(1.5, Math.max(0.8, opts.rate));
      u.onend = next;
      u.onerror = () => {
        if (token === this.#token) this.#set(null);
      };
      synth.speak(u);
    };
    this.#set(id);
    next();
    return true;
  }

  stop(): void {
    const was = this.#id !== null;
    this.#token++;
    if (speechSupported() && (was || window.speechSynthesis.speaking || window.speechSynthesis.pending)) window.speechSynthesis.cancel();
    if (was) this.#set(null);
  }
}

export const speaker = new Speaker();

// 离开页面：停止朗读
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => speaker.stop());
