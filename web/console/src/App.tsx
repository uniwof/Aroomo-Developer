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
      <Route
        path="chat"
        element={
          <Suspense fallback={<p role="status" className="p-4">正在打开对话…</p>}>
            <ChatPage />
          </Suspense>
        }
      />
      {/* 旧控制台页面一律并进对话页（自审 C1：不再有第二套侧栏和样式）；旧链接按页面带到对话页里对应的面板 */}
      {['members', 'tools', 'library', 'inbox', 'executors', 'keys', 'audit', 'settings'].map((v) => (
        <Route key={v} path={v} element={<Navigate to={`/chat?view=${v}`} replace />} />
      ))}
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
