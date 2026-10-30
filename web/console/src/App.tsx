import { useSyncExternalStore } from 'react';
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
import { session } from '@/lib/api';


export function App() {
  const token = useSyncExternalStore(session.subscribe, () => session.token);
  if (!token) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/members" replace />} />
        <Route path="members" element={<Members />} />
        <Route path="tools" element={<Tools />} />
        <Route path="library" element={<Library />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="executors" element={<Executors />} />
        <Route path="keys" element={<Keys />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/members" replace />} />
      </Route>
    </Routes>
  );
}
