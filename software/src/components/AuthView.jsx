import {
  setSessionField,
  submitLoginFromStore,
  useSession
} from "../state/sessionStore.js";
import { useUiShell } from "../state/uiShellStore.js";

export function AuthView() {
  const { authError, isAuthenticated } = useUiShell();
  const session = useSession();

  return (
    <div id="authView" className={`auth-shell${isAuthenticated ? " hidden" : ""}`}>
      <div className="auth-card">
        <div className="auth-header">
          <img src="/assets/safekeys-logo.svg" alt="SafeKeys logo" className="logo-mark" />
          <span className="eyebrow">SafeKeys Secure Access</span>
          <h1 className="auth-title">Zaloguj się do panelu SafeKeys.</h1>
          <p className="auth-subtitle">
            Dostęp do centrum operacyjnego SafeKeys wymaga poprawnego loginu i hasła skonfigurowanych po stronie serwera.
          </p>
        </div>

        <form id="loginForm" className="auth-form" onSubmit={event => {
          event.preventDefault();
          submitLoginFromStore();
        }}
        >
          <label className="field">
            <span className="field-label">Login</span>
            <input
              id="loginUsername"
              type="text"
              autoComplete="username"
              required
              value={session.username}
              onChange={event => setSessionField("username", event.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">Hasło</span>
            <input
              id="loginPassword"
              type="password"
              autoComplete="current-password"
              required
              value={session.password}
              onChange={event => setSessionField("password", event.target.value)}
            />
          </label>

          <button type="submit" disabled={session.submitting}>
            {session.submitting ? "Logowanie..." : "Zaloguj"}
          </button>
          <div id="authError" className="auth-error">{authError}</div>
        </form>
      </div>
    </div>
  );
}
