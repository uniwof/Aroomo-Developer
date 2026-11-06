/**
 * 断网提示（F-020，负责人阶段 4 裁定）：一行静态提示；断网时读屏只播一次，网回来也只说一次，不要一闪一闪。
 * 网络状态要稳定 SETTLE_MS 才算数：来回跳的时候不切换，也就不会反复显示和播报。
 * shortcut: 只看浏览器的 navigator.onLine，连得上 Wi-Fi 但服务器不通时不算断网（发送失败另有人话报错，store.ts）；要更准再加心跳。
 */
import { useEffect, useState } from 'react';

export const OFFLINE_NOTE = '已断网，网回来之前消息发不出去。';
export const ONLINE_AGAIN = '网回来了，可以接着发消息。';
export const SETTLE_MS = 1500;

const now = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export function useOnline(): boolean {
  const [online, setOnline] = useState(now);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(t);
      t = setTimeout(() => setOnline(now()), SETTLE_MS);
    };
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      clearTimeout(t);
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, []);
  return online;
}
