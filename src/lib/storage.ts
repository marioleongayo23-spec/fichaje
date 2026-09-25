// The only persistent browser state: Supabase Auth sessions (human and kiosk
// device, separate keys) and the kiosk device's public identifiers. Never labour
// records, receipts, exports, signed URLs, PINs or credentials typed by users.
export const HUMAN_STORAGE_KEY = 'fichaje-auth';
export const KIOSK_STORAGE_KEY = 'fichaje-kiosk-auth';
export const KIOSK_DEVICE_KEY = 'fichaje-kiosk-device';

export function clearStoredSession(storageKey: string): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key === storageKey || key.startsWith(`${storageKey}-`)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable (private mode); nothing persisted to remove.
  }
}
