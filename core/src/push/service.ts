/**
 * X-08 推送提醒（PWA 网页推送）。
 * - 第一版只给所有者范围（scope = 'owner'）；路由层先挡，这里再只给所有者的收件箱条目发。
 * - 触发：收件箱新建条目时（InboxService.onCreated）——助手运行完成 / 失败、有卡片等你确认。
 * - 锁屏上只出现一句固定的短标题，不放正文、不放成员名或金额；点开进收件箱（/console/chat?view=inbox）。
 * - 推送服务说这个订阅没了（404 / 410）就删掉这行；其他失败只记错误名和状态码，不记 endpoint（它就是投递凭据）。
 * - 总开关 PUSH_ENABLED（默认关）；关着时接口 503，不发任何推送。
 */
import type { AuditFn } from '../audit/types.js';
import { badRequest, HttpError } from '../http/errors.js';
import type { InboxItem } from '../inbox/types.js';
import type { PushStore, PushSubscriptionInput } from './store.js';
import { encryptPayload, vapidAuthorization, type VapidKeys } from './webpush.js';

/** 只接受主流浏览器推送服务的地址（防止把 Core 当成向任意地址发 POST 的跳板） */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
/** 一个账号最多几台设备（手机、电脑、平板…）；多了先在别的设备上关掉 */
export const MAX_DEVICES = 10;
const B64U = /^[A-Za-z0-9_-]+$/;
/** 点开通知去哪：收件箱（「等你处理」在最上面）。shortcut: 先统一进收件箱，X-04「滚到那张卡」的深链接做好后再按条目跳 */
export const OPEN_URL = '/console/chat?view=inbox';

export interface PushMessage {
  title: string;
  urgency: 'normal' | 'high';
  tag: string;
}

/** 收件箱条目 → 锁屏上的一句话；不需要提醒的返回 null。只用固定文字，不拼条目里的任何内容 */
export function pushFor(item: InboxItem): PushMessage | null {
  if (item.kind === 'assistant.run.done') return { title: '助手运行完成', urgency: 'normal', tag: item.id };
  if (item.kind === 'assistant.run.failed') return { title: '助手运行失败', urgency: 'normal', tag: item.id };
  if (item.group === 'decision' && item.actions.length > 0) return { title: '有事等你确认', urgency: 'high', tag: item.id };
  return null;
}

export function validEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

export interface PushServiceDeps {
  store: PushStore;
  /** null = 总开关关着（PUSH_ENABLED 不是 true） */
  vapid: VapidKeys | null;
  now: () => Date;
  fetch?: typeof fetch;
  /** 只记错误名 / 状态码 */
  log?: (msg: string, data: Record<string, unknown>) => void;
}

export class PushService {
  readonly #fetch: typeof fetch;
  constructor(private readonly d: PushServiceDeps) {
    this.#fetch = d.fetch ?? fetch;
  }

  get enabled(): boolean {
    return this.d.vapid !== null;
  }

  #requireEnabled(): VapidKeys {
    if (!this.d.vapid) throw new HttpError(503, 'PUSH_DISABLED', '服务器还没有打开推送提醒');
    return this.d.vapid;
  }

  async status(userId: string): Promise<{ enabled: boolean; publicKey: string | null; devices: number }> {
    if (!this.d.vapid) return { enabled: false, publicKey: null, devices: 0 };
    return { enabled: true, publicKey: this.d.vapid.publicKey, devices: (await this.d.store.list(userId)).length };
  }

  async subscribe(userId: string, s: PushSubscriptionInput, audit: AuditFn): Promise<{ created: boolean }> {
    this.#requireEnabled();
    if (!validEndpoint(s.endpoint)) throw badRequest('这个推送地址不是浏览器的推送服务', 'INVALID_ENDPOINT');
    const p = Buffer.from(s.p256dh, 'base64url');
    const a = Buffer.from(s.auth, 'base64url');
    if (!B64U.test(s.p256dh) || !B64U.test(s.auth) || p.length !== 65 || p[0] !== 4 || a.length !== 16) throw badRequest('推送订阅的密钥格式不对', 'INVALID_KEYS');
    const existing = await this.d.store.list(userId);
    if (!existing.some((r) => r.endpoint === s.endpoint) && existing.length >= MAX_DEVICES) {
      throw new HttpError(409, 'TOO_MANY_DEVICES', `最多 ${MAX_DEVICES} 台设备收推送提醒，请先在不用的设备上关掉`);
    }
    const out = await this.d.store.upsert(userId, s, this.d.now());
    await audit('push.subscribe', { type: 'push', id: userId }, 'ok', out.created ? 'new device' : 'refreshed');
    return out;
  }

  async unsubscribe(userId: string, endpoint: string, audit: AuditFn): Promise<boolean> {
    const removed = await this.d.store.remove(userId, endpoint);
    if (removed) await audit('push.unsubscribe', { type: 'push', id: userId }, 'ok');
    return removed;
  }

  /** 设置里的「发一条试试」 */
  async sendTest(userId: string): Promise<{ sent: number }> {
    this.#requireEnabled();
    return this.send(userId, { title: 'Aroomo 推送提醒已打开', urgency: 'normal', tag: 'test' });
  }

  /** InboxService.onCreated 的监听：第一版只给所有者 */
  async notifyInbox(item: InboxItem): Promise<void> {
    if (!this.d.vapid || item.userId !== undefined) return;
    const m = pushFor(item);
    if (m) await this.send('owner', m);
  }

  async send(userId: string, m: PushMessage): Promise<{ sent: number }> {
    const vapid = this.d.vapid;
    if (!vapid) return { sent: 0 };
    const body = Buffer.from(JSON.stringify({ title: m.title, url: OPEN_URL, tag: m.tag }));
    let sent = 0;
    for (const s of await this.d.store.list(userId)) {
      try {
        const res = await this.#fetch(s.endpoint, {
          method: 'POST',
          headers: {
            Authorization: vapidAuthorization(s.endpoint, vapid, this.d.now()),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '86400',
            Urgency: m.urgency,
          },
          body: encryptPayload(body, s),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        if (res.status === 404 || res.status === 410) await this.d.store.remove(userId, s.endpoint);
        else if (res.ok) sent++;
        else this.d.log?.('push send failed', { status: res.status });
      } catch (e) {
        this.d.log?.('push send failed', { errName: (e as Error).name });
      }
    }
    return { sent };
  }
}
