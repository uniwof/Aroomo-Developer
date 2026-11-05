import { lazy, Suspense, useSyncExternalStore } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Login } from '@/pages/Login';
import { Accept } from '@/pages/Accept';
import { session, viaShell } from '@/lib/api';


// 对话页单独打包（assistant-ui 体积大），只看管理页面时不用下载它
const ChatPage = lazy(() => import('@/chat/ChatPage').then((m) => ({ default: m.ChatPage })));

export function App() {
  const token = useSyncExternalStore(session.subscribe, () => session.token);
  // 凭链接设密码页不需要登录
  if (/^\/console\/accept\/?$/.test(window.location.pathname)) return <Accept />;
  if (!token && !viaShell) return <Login />;
  return (
    <Routes>
      {/* 打开 Aroomo 直接进对话（#250 方向 A）；对话页自带一层抽屉，不套控制台侧栏 */}
      <Route index element={<Navigate to="/chat" replace />} />
      {/* 对话页管所有面板的地址（/chat、/team、/hub、/inbox、/settings…，Poke 行为规范 §2）；旧地址由对话页重定向 */}
      <Route
        path="*"
        element={
          <Suspense fallback={<p role="status" className="p-4">正在打开对话…</p>}>
            <ChatPage />
          </Suspense>
        }
      />
    </Routes>
  );
}
