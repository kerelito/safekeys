import { useSyncExternalStore } from "react";
import { setAuthError } from "./uiShellStore.js";

const listeners = new Set();
let handlers = {
  onLogout: async () => {},
  onSubmit: async () => {}
};
let state = {
  password: "",
  submitting: false,
  username: ""
};

function emit() {
  listeners.forEach(listener => listener());
}

function updateState(patch) {
  state = {
    ...state,
    ...patch
  };
  emit();
  return state;
}

export function configureSessionHandlers(nextHandlers = {}) {
  handlers = {
    ...handlers,
    ...nextHandlers
  };
}

export function subscribeSession(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSessionSnapshot() {
  return state;
}

export function setSessionField(name, value) {
  if (!Object.prototype.hasOwnProperty.call(state, name) || name === "submitting") {
    return state;
  }

  setAuthError("");
  return updateState({ [name]: value });
}

export function clearSessionFields({ keepUsername = true } = {}) {
  return updateState({
    password: "",
    username: keepUsername ? state.username : ""
  });
}

export async function submitLoginFromStore() {
  if (state.submitting) {
    return;
  }

  const username = state.username.trim();
  const password = state.password;

  updateState({ submitting: true });
  setAuthError("");

  try {
    await handlers.onSubmit({ password, username });
    updateState({
      password: "",
      submitting: false
    });
  } catch (error) {
    updateState({ submitting: false });
    setAuthError(error.message);
  }
}

export async function logoutFromStore() {
  await handlers.onLogout();
}

export function useSession() {
  return useSyncExternalStore(subscribeSession, getSessionSnapshot, getSessionSnapshot);
}
