import { lazy, Suspense, useSyncExternalStore } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Login } from '@/pages/Login';
import { Members } from '@/pages/Members';
import { Keys } from '@/pages/Keys';
import { Inbox } from '@/pages/Inbox';
import { Settings } from '@/pages/Settings';
import { Tools } from '@/pages/Tools';
import { Library } from '@/pages/Library';
import { Executors } from '@/pages/Executors';
import { Audit } from '@/pages/Audit';
import { session, viaShell } from '@/lib/api';


// 对话页单独打包（assistant-ui 体积大），只看管理页面时不用下载它
const ChatPage = lazy(() => import('@/chat/ChatPage').then((m) => ({ default: m.ChatPage })));

export function App() {
  const token = useSyncExternalStore(session.subscribe, () => session.token);
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
      <Route element={<Layout />}>
        <Route path="members" element={<Members />} />
        <Route path="tools" element={<Tools />} />
        <Route path="library" element={<Library />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="executors" element={<Executors />} />
        <Route path="keys" element={<Keys />} />
        <Route path="audit" element={<Audit />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  );
}
