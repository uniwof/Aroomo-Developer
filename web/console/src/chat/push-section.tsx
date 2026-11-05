/**
 * X-08 推送提醒（设置 → 推送提醒，只有所有者）。
 * - 不自动弹浏览器的通知授权：只有点了「在这台设备上打开」才问（先讲清楚会收到什么）。
 * - 锁屏上只有一句话（「有事等你确认」「助手运行完成」），不含内容；点开进收件箱。
 * - iPhone / iPad 要先「添加到主屏幕」、从主屏幕打开，Safari 才给网页推送（iOS 16.4+）。
 * - 服务器没开（PUSH_ENABLED）时只说一句，不放按钮。
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Field, Group } from '@/pages/Settings';
import { errText } from './ui';

interface Status {
  enabled: boolean;
  publicKey: string | null;
  devices: number;
}
type Local = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on';

const SW_URL = '/console/sw.js';
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** base64url → Uint8Array（applicationServerKey 要字节） */
function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function currentSub(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

async function localState(): Promise<Local> {
  if (!supported()) return isIos() && !standalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return (await currentSub()) ? 'on' : 'off';
}

export function PushSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [local, setLocal] = useState<Local | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([api<Status>('GET', '/api/push'), localState()]);
      setStatus(s);
      setLocal(l);
    } catch (e) {
      setErr(errText(e, '推送提醒的状态查不到，请稍后再试'));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function turnOn() {
    if (!status?.publicKey) return;
    setBusy(true);
    setMsg('');
    try {
      // 浏览器的授权框只在这里（用户点了按钮之后）出现
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setLocal(perm === 'denied' ? 'denied' : 'off');
        setMsg('没有打开：浏览器没允许通知。');
        return;
      }
      const reg = await navigator.serviceWorker.register(SW_URL, { scope: '/console/' });
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) }));
      await api('POST', '/api/push/subscriptions', sub.toJSON());
      setMsg('已打开。可以点「发一条试试」看看锁屏上的样子。');
      await refresh();
    } catch (e) {
      setMsg(errText(e, '没打开成功，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setMsg('');
    try {
      const sub = await currentSub();
      if (sub) {
        await api('POST', '/api/push/subscriptions/remove', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setMsg('这台设备已关掉推送提醒。');
      await refresh();
    } catch (e) {
      setMsg(errText(e, '没关成功，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setMsg('');
    try {
      const r = await api<{ sent: number }>('POST', '/api/push/test');
      setMsg(r.sent > 0 ? `已发出，${r.sent} 台设备会收到。` : '没发出去：推送服务没回应，请稍后再试。');
    } catch (e) {
      setMsg(errText(e, '没发出去，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }

  if (err) return <p role="alert" className="note note-error">{err}</p>;
  if (!status || !local) return <p className="note">正在加载…</p>;

  return (
    <>
      <Group footer="提醒里只有一句话，比如「有事等你确认」「助手运行完成」，不含具体内容。点开会进收件箱。">
        <div className="row">
            <span>打开后，助手做完事、运行失败，或者有事等你确认时，这台手机或电脑的锁屏上会出现一句提醒。</span>
          </div>
        {!status.enabled ? (
          <Field label="这台设备">
            <span>服务器还没有打开推送提醒</span>
          </Field>
        ) : local === 'ios-install' ? (
          <div className="row">
            <span>iPhone、iPad 要先把 Aroomo 放到主屏幕：在 Safari 里点「分享」→「添加到主屏幕」，再从主屏幕打开 Aroomo，回到这里打开推送提醒。</span>
          </div>
        ) : local === 'unsupported' ? (
          <Field label="这台设备">
            <span>这个浏览器收不到推送提醒</span>
          </Field>
        ) : local === 'denied' ? (
          <div className="row">
            <span>你之前没允许 Aroomo 发通知。请在浏览器的网站设置里把「通知」改成允许，再回到这里打开。</span>
          </div>
        ) : local === 'on' ? (
          <>
            <Field label="这台设备" hint="已打开">
              <button type="button" className="btn btn-outline hit" disabled={busy} onClick={() => void turnOff()}>
                在这台设备上关掉
              </button>
            </Field>
            <Field label="试一下">
              <button type="button" className="btn btn-outline hit" disabled={busy} onClick={() => void test()}>
                发一条试试
              </button>
            </Field>
          </>
        ) : (
          <Field label="这台设备" hint="没打开。点了以后浏览器会问你是否允许通知。">
            <button type="button" className="btn btn-primary hit" disabled={busy} onClick={() => void turnOn()}>
              在这台设备上打开
            </button>
          </Field>
        )}
        {status.enabled && (
          <Field label="一共">
            <span>{status.devices} 台设备在收</span>
          </Field>
        )}
      </Group>
      <p role="status" className="row-status">
        {msg}
      </p>
    </>
  );
}
