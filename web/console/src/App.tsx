import { useSyncExternalStore } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Login } from '@/pages/Login';
import { Members } from '@/pages/Members';
import { Keys } from '@/pages/Keys';
import { Inbox } from '@/pages/Inbox';
import { Pending } from '@/pages/Pending';
import { Settings } from '@/pages/Settings';
import { Library } from '@/pages/Library';
import { session } from '@/lib/api';

const soon = '这一页正在从旧界面迁过来，很快就能用。';

export function App() {
  const token = useSyncExternalStore(session.subscribe, () => session.token);
  if (!token) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/members" replace />} />
        <Route path="members" element={<Members />} />
        <Route path="tools" element={<Pending title="工具" note={soon} />} />
        <Route path="library" element={<Library />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="executors" element={<Pending title="本机执行员" note={soon} />} />
        <Route path="keys" element={<Keys />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/members" replace />} />
      </Route>
    </Routes>
  );
}
