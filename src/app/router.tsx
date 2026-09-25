import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';

// Minimal history router: real links (keyboard, screen readers, new tab) and
// no framework. Routes never carry credentials, PINs, tokens or labour data.
interface RouterValue { path: string; navigate: (to: string) => void }
const RouterContext = createContext<RouterValue>({ path: '/', navigate: () => {} });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to !== window.location.pathname) window.history.pushState(null, '', to);
    setPath(to);
  }, []);
  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  return useContext(RouterContext);
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const { path, navigate } = useRouter();
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} className={className} onClick={onClick} aria-current={path === to ? 'page' : undefined}>{children}</a>;
}
