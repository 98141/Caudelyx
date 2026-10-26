import { useEffect, useRef, useState, type ReactNode } from 'react';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 767px)');
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return narrow;
}

export function AppShell({
  route,
  navigation,
  children,
}: {
  route: string;
  navigation: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const narrow = useNarrow();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusNav = () => {
    requestAnimationFrame(() => document.getElementById('app-nav')?.querySelector<HTMLElement>('a, button')?.focus());
  };
  const focusToggle = () => {
    requestAnimationFrame(() => toggleRef.current?.focus());
  };
  useEffect(() => { setOpen(false); }, [route]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      focusToggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className={open ? 'app-shell nav-open' : 'app-shell'}>
      <header className="app-bar">
        <button
          ref={toggleRef}
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="app-nav"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) focusNav();
            else focusToggle();
          }}
        >{open ? 'Cerrar menú' : 'Abrir menú'}</button>
        <img src="/brand/caudelyx-wordmark.png" alt="Caudelyx" width={960} height={481} />
      </header>
      <div className="app-body">
        <button type="button" className="nav-backdrop" aria-label="Cerrar el menú de secciones" onClick={() => { setOpen(false); focusToggle(); }} />
        <div className="app-nav-slot" inert={narrow && !open ? true : undefined}>
          {navigation}
        </div>
        {children}
      </div>
    </div>
  );
}

export function NavIcon({ hash }: { hash: string }) {
  const path = ICON_PATH[hash] ?? ICON_PATH['#/perfil'];
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}

const ICON_PATH: Record<string, string> = {
  '#/inicio': 'M4 4h16v4H4zM4 10h16v10H4z',
  '#/configuracion': 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 12h2M18 12h2M12 4v2M12 18v2',
  '#/ingresar': 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  '#/registro': 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 11h6M19 8v6M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  '#/perfil': 'M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  '#/seguridad': 'M12 3l7 3v6c0 5-3.2 7.6-7 9-3.8-1.4-7-4-7-9V6l7-3z',
  '#/organizacion': 'M3 21V7l9-4 9 4v14M9 21v-6h6v6',
  '#/finanzas': 'M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-6',
  '#/prestatarios': 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M20 8v6M23 11h-6M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  '#/prestamos': 'M4 6h16v12H4zM4 10h16M8 15h3',
  '#/pagos': 'M3 7h18v10H3zM3 11h18M7 15h4',
};
