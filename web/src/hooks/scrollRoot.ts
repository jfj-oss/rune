import { createContext, useContext } from 'react';

/** The element that scrolls the routed page (needed by the virtualized grid and tab scroll-spy). */
export const ScrollRootContext = createContext<{ current: HTMLElement | null }>({ current: null });
export const useScrollRoot = () => useContext(ScrollRootContext);
