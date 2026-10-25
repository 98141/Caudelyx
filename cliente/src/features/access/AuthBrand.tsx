const WORDMARK = '/brand/caudelyx-wordmark.png';
const MARK = '/brand/caudelyx-mark.png';

export function AuthWordmark() {
  return <img className="auth-wordmark" src={WORDMARK} alt="Caudelyx" width={960} height={481} />;
}

export function AuthBrand() {
  return (
    <aside className="auth-brand" aria-label="Presentación de Caudelyx">
      <div className="auth-brand-inner">
        <div className="auth-lockup">
          <img src={MARK} alt="" width={256} height={265} />
          <p className="auth-name">Caudelyx</p>
        </div>
        <div className="auth-copy">
          <h2>El control de tus finanzas comienza aquí</h2>
          <p>Gestiona préstamos, clientes, cuotas y cobranzas desde un solo lugar.</p>
        </div>
        <div className="auth-demo">
          <p className="auth-demo-note">Cifras de demostración. No son datos de una cartera real.</p>
          <ul className="auth-metrics">
            <li>
              <span>Cartera de ejemplo</span>
              <strong>128.450</strong>
              <small>COP de ejemplo</small>
            </li>
            <li>
              <span>Pagos de ejemplo</span>
              <strong>36</strong>
              <small>en el mes</small>
            </li>
            <li>
              <span>Préstamos de ejemplo</span>
              <strong>18</strong>
              <small>en el mes</small>
            </li>
          </ul>
          <div className="auth-charts">
            <div>
              <p className="auth-chart-title">Flujo ilustrativo</p>
              <ul className="auth-bars" aria-hidden="true">
                <li><i /><small>Ene</small></li>
                <li><i /><small>Feb</small></li>
                <li><i /><small>Mar</small></li>
                <li><i /><small>Abr</small></li>
                <li><i /><small>May</small></li>
                <li><i /><small>Jun</small></li>
              </ul>
            </div>
            <div>
              <p className="auth-chart-title">Composición ilustrativa</p>
              <div className="auth-donut" aria-hidden="true" />
              <ul className="auth-legend">
                <li>Capital 42 %</li>
                <li>Intereses 28 %</li>
                <li>Cuotas 30 %</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
