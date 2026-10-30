/**
 * Windows 独立版的「本机主人自动登录」（D78：单一本机主人，不设本地登录密码，信任 Windows 账户）。
 *
 * LobeHub 本身要求一个 Better Auth 账号。独立版安装程序生成一个随机的主人邮箱 / 密码
 * （只在本机配置文件里，当前 Windows 用户才能读，用户永远不需要看到或输入），
 * Shell 在浏览器还没有登录时，替它在服务器端调用 LobeHub 的 Better Auth：
 *   先 POST /api/auth/sign-in/email；账号还不存在（第一次）就 POST /api/auth/sign-up/email（autoSignIn）
 * 再把 LobeHub 返回的会话 Cookie 原样交给浏览器，302 回到原页面。
 *
 * 安全边界：只有 Shell 只听本机回环地址（127.0.0.1 / ::1 / localhost）时才允许开启（config.ts 检查），
 * Docker / 服务器版永远不开。不修改 LobeHub 的任何文件（D69）。
 */

export interface AutoLoginOptions {
  email: string;
  password: string;
  /** 和 LobeHub 的 APP_URL 一致的来源（Better Auth 校验 Origin） */
  origin?: string;
}

export interface AutoLogin {
  /** 成功返回要交给浏览器的 Set-Cookie 列表；失败返回 null（交给正常的登录页） */
  login(): Promise<string[] | null>;
}

/** 防止 Cookie 不生效时无限跳转：自动登录后 30 秒内不再尝试 */
export const AUTOLOGIN_MARK = 'aroomo_al';

export class LobeLocalAutoLogin implements AutoLogin {
  #inflight: Promise<string[] | null> | undefined;

  constructor(
    private readonly lobe: URL,
    private readonly opts: AutoLoginOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  login(): Promise<string[] | null> {
    // 同时打开多个页面时只登录一次
    this.#inflight ??= this.#doLogin().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #post(path: string, body: Record<string, unknown>): Promise<Response | null> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.opts.origin) headers.origin = this.opts.origin;
    try {
      return await this.fetchImpl(new URL(path, this.lobe), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return null;
    }
  }

  async #doLogin(): Promise<string[] | null> {
    const cred = { email: this.opts.email, password: this.opts.password };
    let res = await this.#post('/api/auth/sign-in/email', { ...cred, rememberMe: true });
    if (!res) return null;
    if (!res.ok) {
      // 第一次：主人账号还不存在 → 注册（LobeHub 设置 autoSignIn: true，注册即登录）
      if (res.status !== 401 && res.status !== 400 && res.status !== 404) return null;
      const up = await this.#post('/api/auth/sign-up/email', { ...cred, name: '主人' });
      if (!up || !up.ok) return null;
      // 注册成功后再正常登录一次，拿标准的登录会话（注册时的自动登录会话作为后备）
      const again = await this.#post('/api/auth/sign-in/email', { ...cred, rememberMe: true });
      res = again && again.ok && again.headers.getSetCookie().length > 0 ? again : up;
    }
    const cookies = res.headers.getSetCookie();
    return cookies.length > 0 ? cookies : null;
  }
}

/** 登录页 / 注册页上的 callbackUrl：只接受本站相对路径 */
export function safeCallback(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/^\/(signin|signup)(\/|\?|$)/.test(raw)) return '/';
  return raw;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
