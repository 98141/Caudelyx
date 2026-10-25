type SocialProviderId = 'google' | 'facebook';

const PROVIDERS: Record<SocialProviderId, string> = {
  google: 'Continuar con Google',
  facebook: 'Continuar con Facebook',
};

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}

function FacebookMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#1877F2" d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z" />
    </svg>
  );
}

export function SocialSignIn({ provider }: { provider: SocialProviderId }) {
  return (
    <button type="button" className={`social-button social-${provider}`} disabled>
      {provider === 'google' ? <GoogleMark /> : <FacebookMark />}
      <span className="social-label">{PROVIDERS[provider]}</span>
      <span className="social-soon">Próximamente</span>
    </button>
  );
}

export function SocialSignInGroup() {
  return (
    <div className="social-group">
      <p className="auth-divider"><span>O continúa con</span></p>
      <div className="social-actions">
        <SocialSignIn provider="google" />
        <SocialSignIn provider="facebook" />
      </div>
    </div>
  );
}
