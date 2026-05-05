export function AuthView() {
  return (
    <div id="authView" className="auth-shell hidden">
      <div className="auth-card">
        <div className="auth-header">
          <img src="/assets/safekeys-logo.svg" alt="SafeKeys logo" className="logo-mark" />
          <span className="eyebrow">SafeKeys Secure Access</span>
          <h1 className="auth-title">Zaloguj się do panelu SafeKeys.</h1>
          <p className="auth-subtitle">
            Dostęp do centrum operacyjnego SafeKeys wymaga poprawnego loginu i hasła skonfigurowanych po stronie serwera.
          </p>
        </div>

        <form id="loginForm" className="auth-form">
          <label className="field">
            <span className="field-label">Login</span>
            <input id="loginUsername" type="text" autoComplete="username" required />
          </label>

          <label className="field">
            <span className="field-label">Hasło</span>
            <input id="loginPassword" type="password" autoComplete="current-password" required />
          </label>

          <button type="submit">Zaloguj</button>
          <div id="authError" className="auth-error" />
        </form>
      </div>
    </div>
  );
}
