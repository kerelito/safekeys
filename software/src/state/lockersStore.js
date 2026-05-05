import { useSyncExternalStore } from "react";
import { apiFetch } from "../services/apiClient.js";

const listeners = new Set();
let handlers = {
  onAfterRefresh: () => {},
  onOpenLocker: async () => {},
  onOpenDetails: () => {},
  onReleaseAll: async () => {}
};
let state = {
  lockers: []
};

function emit() {
  listeners.forEach(listener => listener());
}

function setLockers(lockers) {
  state = {
    lockers: Array.isArray(lockers) ? lockers : []
  };
  emit();
  handlers.onAfterRefresh(state.lockers);
  return state.lockers;
}

export function configureLockersHandlers(nextHandlers = {}) {
  handlers = {
    ...handlers,
    ...nextHandlers
  };
}

export function subscribeLockers(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLockersSnapshot() {
  return state;
}

export async function refreshLockers() {
  return setLockers(await apiFetch("/lockers"));
}

export function clearLockers() {
  return setLockers([]);
}

export function openLockerFromStore(locker) {
  return handlers.onOpenLocker(locker);
}

export function openLockerDetailsFromStore(locker) {
  return handlers.onOpenDetails(locker);
}

export function releaseAllLockersFromStore() {
  return handlers.onReleaseAll();
}

export function useLockers() {
  return useSyncExternalStore(subscribeLockers, getLockersSnapshot, getLockersSnapshot);
}
