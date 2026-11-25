export interface TokenStore {
  get(): { token: string; expiresAt: string } | null;
  set(v: { token: string; expiresAt: string }): void;
  clear(): void;
}

const KEY = 'pulse.session';

/**
 * Stores ONLY the short-lived (default 2h) opaque session token, never the pairing code or any exchange credential.
 * WebView storage is not a secure enclave; this limitation is documented in docs/SECURITY.md.
 */
export function createTokenStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeStorage()): TokenStore {
  let mem: { token: string; expiresAt: string } | null = null;
  return {
    get() {
      try {
        const raw = storage?.getItem(KEY);
        const v = raw ? (JSON.parse(raw) as { token: string; expiresAt: string }) : mem;
        if (v && new Date(v.expiresAt).getTime() > Date.now()) return v;
      } catch {
        // fall through
      }
      return null;
    },
    set(v) {
      mem = v;
      try { storage?.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable: memory only */ }
    },
    clear() {
      mem = null;
      try { storage?.removeItem(KEY); } catch { /* ignore */ }
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
