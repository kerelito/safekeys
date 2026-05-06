import { useSyncExternalStore } from "react";

const THEME_STORAGE_KEY = "locker-theme";
const DENSITY_STORAGE_KEY = "locker-density";
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set();

function readStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return ["system", "dark", "light"].includes(stored) ? stored : "system";
}

function readStoredDensity() {
  const stored = localStorage.getItem(DENSITY_STORAGE_KEY);
  return stored === "compact" || stored === "simple" ? "simple" : "advanced";
}

function resolveTheme(theme) {
  return theme === "system" ? (themeMedia.matches ? "dark" : "light") : theme;
}

function normalizeState(nextState) {
  let activePage = nextState.activePage || "dashboard";

  if (nextState.density === "simple" && activePage !== "dashboard") {
    activePage = "dashboard";
  }

  if (activePage === "panelUsers" && !nextState.canAccessPanelUsers) {
    activePage = "dashboard";
  }

  return {
    ...nextState,
    activePage,
    resolvedTheme: resolveTheme(nextState.theme)
  };
}

let state = normalizeState({
  theme: readStoredTheme(),
  density: readStoredDensity(),
  activePage: "dashboard",
  menuOpen: false,
  authError: "",
  canAccessPanelUsers: false,
  canManageRfid: false,
  canOperateLockers: false,
  currentDisplayName: "",
  currentRoleLabel: "",
  currentUsername: "",
  isAuthenticated: false
});

function applyDocumentState() {
  document.documentElement.dataset.theme = state.resolvedTheme;
  document.documentElement.dataset.density = state.density === "simple" ? "compact" : "comfort";
  document.documentElement.dataset.viewMode = state.density;

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute("content", state.resolvedTheme === "dark" ? "#07111f" : "#edf3ff");
  }
}

function emit() {
  applyDocumentState();
  listeners.forEach(listener => listener());
}

function updateState(patch) {
  state = normalizeState({ ...state, ...patch });
  emit();
  return state;
}

export function subscribeUiShell(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUiShellSnapshot() {
  return state;
}

export function getActivePage() {
  return state.activePage;
}

export function setActivePage(page, { closeMenu = true } = {}) {
  return updateState({
    activePage: page,
    menuOpen: closeMenu ? false : state.menuOpen
  }).activePage;
}

export function toggleMenu(forceOpen = null) {
  const menuOpen = forceOpen === null ? !state.menuOpen : Boolean(forceOpen);
  return updateState({ menuOpen }).menuOpen;
}

export function closeMenu() {
  return toggleMenu(false);
}

export function cycleTheme() {
  const nextTheme = state.theme === "system" ? "dark" : state.theme === "dark" ? "light" : "system";
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  return updateState({ theme: nextTheme }).theme;
}

export function toggleDensity() {
  const nextDensity = state.density === "simple" ? "advanced" : "simple";
  localStorage.setItem(DENSITY_STORAGE_KEY, nextDensity);
  return updateState({ density: nextDensity }).density;
}

export function setPanelUsersAccess(canAccessPanelUsers) {
  return updateState({ canAccessPanelUsers: Boolean(canAccessPanelUsers) });
}

export function setRfidAdminAccess(canManageRfid) {
  return updateState({ canManageRfid: Boolean(canManageRfid) });
}

export function setOperationAccess(canOperateLockers) {
  return updateState({ canOperateLockers: Boolean(canOperateLockers) });
}

export function setAuthState({ authError = state.authError, isAuthenticated = state.isAuthenticated } = {}) {
  return updateState({
    authError,
    isAuthenticated: Boolean(isAuthenticated)
  });
}

export function setAuthError(authError = "") {
  return updateState({ authError });
}

export function setCurrentUserSummary({ displayName = "", roleLabel = "", username = "" } = {}) {
  return updateState({
    currentDisplayName: displayName,
    currentRoleLabel: roleLabel,
    currentUsername: username
  });
}

export function useUiShell() {
  const snapshot = useSyncExternalStore(subscribeUiShell, getUiShellSnapshot, getUiShellSnapshot);

  return {
    ...snapshot,
    closeMenu,
    cycleTheme,
    setActivePage,
    toggleDensity,
    toggleMenu
  };
}

themeMedia.addEventListener("change", () => {
  if (state.theme === "system") {
    updateState({ theme: "system" });
  }
});

applyDocumentState();
