import { SystemStatusIndicators } from "./SystemStatusIndicators.jsx";
import { useUiShell } from "../state/uiShellStore.js";

export function TopBar() {
  const { density, menuOpen, theme, cycleTheme, toggleDensity, toggleMenu } = useUiShell();

  return (
    <div className="topbar">
      <div className="brand">
        <img src="/assets/safekeys-logo.svg" alt="SafeKeys logo" className="brand-mark" />
        <div className="brand-copy">
          <span className="eyebrow">SafeKeys Access Platform</span>
          <span className="brand-title">SafeKeys Command Center</span>
        </div>
      </div>

      <div className="topbar-actions">
        <button id="themeToggle" className="theme-toggle" type="button" onClick={cycleTheme}>Motyw: {theme}</button>
        <button id="compactToggle" className="theme-toggle compact-toggle" type="button" onClick={toggleDensity}>
          {density === "simple" ? "Tryb: prosty" : "Tryb: zaawansowany"}
        </button>
        <div id="userChip" className="user-chip hidden">
          <strong id="userDisplayName" />
          <span id="userUsername" />
        </div>
        <button id="logoutButton" className="logout-button" type="button">Wyloguj</button>
        <SystemStatusIndicators />
        <button
          id="menuButton"
          className="menu-button"
          type="button"
          aria-label="Otwórz menu"
          aria-expanded={menuOpen}
          onClick={() => toggleMenu()}
        >
          <span />
        </button>
      </div>
    </div>
  );
}
