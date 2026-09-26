// The service worker only serves the public application shell. No background
// sync, periodic sync or push is registered: clock actions are never queued.
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}
