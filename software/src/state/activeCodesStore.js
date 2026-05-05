import { useSyncExternalStore } from "react";
import { apiFetch } from "../services/apiClient.js";

const listeners = new Set();
let handlers = {
  afterChange: async () => {},
  canDeactivate: () => false,
  showToast: () => {}
};
let state = {
  activeCodes: []
};

function emit() {
  listeners.forEach(listener => listener());
}

function setActiveCodes(activeCodes) {
  state = {
    activeCodes: Array.isArray(activeCodes) ? activeCodes : []
  };
  emit();
  return state.activeCodes;
}

async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function configureActiveCodesHandlers(nextHandlers = {}) {
  handlers = {
    ...handlers,
    ...nextHandlers
  };
}

export function subscribeActiveCodes(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveCodesSnapshot() {
  return state;
}

export async function refreshActiveCodes() {
  return setActiveCodes(await apiFetch("/active-codes"));
}

export function pruneExpiredActiveCodes(now = Date.now()) {
  const nextCodes = state.activeCodes.filter(code => new Date(code.expiresAt).getTime() > now);

  if (nextCodes.length !== state.activeCodes.length) {
    return setActiveCodes(nextCodes);
  }

  return state.activeCodes;
}

export function clearActiveCodes() {
  return setActiveCodes([]);
}

export async function deactivateActiveCode(code) {
  if (!handlers.canDeactivate()) {
    handlers.showToast("Nie masz uprawnień do dezaktywacji kodów.", true);
    return;
  }

  try {
    await apiFetch("/deactivate-code", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ code })
    });

    handlers.showToast("Kod dezaktywowany");
    await refreshActiveCodes();
    await handlers.afterChange();
  } catch (error) {
    handlers.showToast(error.message, true);
  }
}

export async function copyActiveCode(code) {
  const text = String(code || "").trim();
  if (!text) {
    handlers.showToast("Nie ma czego skopiować.", true);
    return;
  }

  try {
    await writeClipboard(text);
    handlers.showToast(`Skopiowano kod ${text}.`);
  } catch (error) {
    handlers.showToast("Nie udało się skopiować do schowka.", true);
  }
}

export function useActiveCodes() {
  return useSyncExternalStore(subscribeActiveCodes, getActiveCodesSnapshot, getActiveCodesSnapshot);
}
