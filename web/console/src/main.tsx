import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { applyDisplay, readDisplayPrefs } from './lib/display';
import './index.css';

// 字号 / 主题偏好先套上，再画页面（不闪一下小字）
applyDisplay(readDisplayPrefs());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename="/console">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
