const STEPS = [
  'Crear cuenta',
  'Confirmar correo y crear contraseña',
  'Proteger cuenta',
  'Continuar',
] as const;

export function OnboardingSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <ol className="steps" aria-label="Recorrido de acceso">
      {STEPS.map((label, index) => {
        const number = index + 1;
        return (
          <li key={label} aria-current={number === current ? 'step' : undefined}>
            <span>{number}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}
