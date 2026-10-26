import { useEffect, useId, useRef, useState } from 'react';

export interface ComboOption {
  id: string;
  code: string;
  name: string;
  kindLabel: string;
  statusLabel?: string;
}

export function AccountCombobox({
  label, options, value, onChange, query, onQuery, loading,
}: {
  label: string;
  options: ComboOption[];
  value: string;
  onChange: (id: string) => void;
  query: string;
  onQuery: (value: string) => void;
  loading: boolean;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find(item => item.id === value) ?? null;

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, []);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.id);
    setOpen(false);
  }

  function caption(option: ComboOption): string {
    return `${option.code} · ${option.name} · ${option.kindLabel}${option.statusLabel ? ` · ${option.statusLabel}` : ''}`;
  }

  return (
    <div className="combo" ref={root}>
      <label>
        <span>{label}</span>
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${options[active].id}` : undefined}
          value={open ? query : (selected ? caption(selected) : query)}
          placeholder="Busca por código o nombre"
          autoComplete="off"
          onFocus={() => setOpen(true)}
          onChange={event => { onQuery(event.target.value); setOpen(true); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(options.length - 1, index + 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
            if (event.key === 'Home') { event.preventDefault(); setActive(0); }
            if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, options.length - 1)); }
            if (event.key === 'Enter' && open) { event.preventDefault(); choose(active); }
            if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
          }}
        />
      </label>
      {loading ? <p role="status">Cargando cuentas…</p> : null}
      {open ? (
        <ul id={listId} role="listbox" aria-label={label}>
          {options.length === 0 ? <li role="presentation">Sin cuentas en esta página.</li> : options.map((option, index) => (
            <li
              key={option.id}
              id={`${listId}-${option.id}`}
              role="option"
              aria-selected={option.id === value}
              data-active={index === active ? 'true' : 'false'}
              onMouseEnter={() => setActive(index)}
              onMouseDown={event => { event.preventDefault(); choose(index); }}
            >{caption(option)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
