import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type SupabaseClientEnv = Record<string, string | boolean | undefined>;

export type SupabaseConfigResult =
  | {
      configured: true;
      url: string;
      anonKey: string;
    }
  | {
      configured: false;
      code: 'CLIENT_SUPABASE_NOT_CONFIGURED';
      reason: string;
    };

export const SUPABASE_BROWSER_AUTH_OPTIONS = {
  flowType: 'pkce',
  detectSessionInUrl: true,
  autoRefreshToken: true,
  persistSession: true,
} as const;

function isValidSupabaseBrowserUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') {
      return Boolean(parsed.hostname);
    }
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Reads only public browser-safe `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` configuration.
 * Never reads or forwards privileged server-side service-role keys or server secrets.
 */
export function readSupabaseClientConfig(
  env?: SupabaseClientEnv,
): SupabaseConfigResult {
  const sourceEnv: SupabaseClientEnv = env ?? {
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  };
  const rawUrl =
    typeof sourceEnv.VITE_SUPABASE_URL === 'string' ? sourceEnv.VITE_SUPABASE_URL.trim() : '';
  const rawAnonKey =
    typeof sourceEnv.VITE_SUPABASE_ANON_KEY === 'string'
      ? sourceEnv.VITE_SUPABASE_ANON_KEY.trim()
      : '';

  if (!rawUrl || !rawAnonKey) {
    return {
      configured: false,
      code: 'CLIENT_SUPABASE_NOT_CONFIGURED',
      reason:
        'Supabase browser credentials (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are not configured.',
    };
  }

  if (!isValidSupabaseBrowserUrl(rawUrl)) {
    return {
      configured: false,
      code: 'CLIENT_SUPABASE_NOT_CONFIGURED',
      reason: 'VITE_SUPABASE_URL must be a valid https:// URL (or http://localhost in development).',
    };
  }

  return {
    configured: true,
    url: rawUrl,
    anonKey: rawAnonKey,
  };
}

export function createBrowserSupabaseClient(config: {
  url: string;
  anonKey: string;
}): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: {
      ...SUPABASE_BROWSER_AUTH_OPTIONS,
    },
  });
}

let cachedClient: SupabaseClient | null = null;
let cachedConfigKey: string | null = null;

export function getSupabaseClient(): {
  client: SupabaseClient | null;
  config: SupabaseConfigResult;
} {
  const config = readSupabaseClientConfig();
  if (!config.configured) {
    return { client: null, config };
  }

  const key = `${config.url}::${config.anonKey}`;
  if (!cachedClient || cachedConfigKey !== key) {
    cachedClient = createBrowserSupabaseClient(config);
    cachedConfigKey = key;
  }

  return { client: cachedClient, config };
}

export function resetSupabaseClientCache(): void {
  cachedClient = null;
  cachedConfigKey = null;
}
