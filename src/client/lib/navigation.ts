import { useCallback, useEffect, useState } from 'react';

const NAVIGATION_EVENT = 'studexo:navigate';

export interface RouteLocation {
  pathname: string;
  search: string;
}

function readCurrentLocation(): RouteLocation {
  if (typeof window === 'undefined') {
    return { pathname: '/', search: '' };
  }
  return {
    pathname: window.location.pathname || '/',
    search: window.location.search || '',
  };
}

export function navigateTo(path: string, options?: { replace?: boolean }): void {
  if (typeof window === 'undefined') {
    return;
  }

  const normalized = path.startsWith('/') ? path : `/${path}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === normalized) {
    return;
  }

  if (options?.replace) {
    window.history.replaceState(null, '', normalized);
  } else {
    window.history.pushState(null, '', normalized);
  }

  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function useLocation(): RouteLocation {
  const [location, setLocation] = useState<RouteLocation>(readCurrentLocation);

  useEffect(() => {
    const sync = () => {
      setLocation(readCurrentLocation());
    };

    window.addEventListener('popstate', sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, []);

  const stableLocation = location;
  return stableLocation;
}

export function useNavigate() {
  return useCallback((path: string, options?: { replace?: boolean }) => {
    navigateTo(path, options);
  }, []);
}
