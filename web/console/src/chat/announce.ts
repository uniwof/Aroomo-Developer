/** 读屏播报：对话区里任何地方都能说一句「已复制」之类的话（写进同一个 role=status 区域，不抢焦点） */
import { createContext, useContext } from 'react';

export const AnnounceContext = createContext<(text: string) => void>(() => undefined);
export const useAnnounce = () => useContext(AnnounceContext);
