// Build flag or development served from an explicit loopback host; never infer a deployed production build is local.
export function localSynthetic(): boolean {
  return import.meta.env.VITE_CAUDELYX_MODE === 'local-synthetic' || (import.meta.env.DEV && typeof window !== 'undefined' && ['localhost','127.0.0.1','[::1]'].includes(window.location.hostname));
}
