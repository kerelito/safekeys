import { useSyncExternalStore } from "react";
import {
  apiFetch,
  buildQueryString
} from "../services/apiClient.js";

const listeners = new Set();
let handlers = {
  onAfterRefresh: () => {},
  onRefreshError: () => {},
  onOpenLocker: async () => {},
  onReleaseAll: async () => {}
};
let state = {
  lockerDetails: {
    error: "",
    loading: false,
    locker: null,
    open: false,
    recentLogs: []
  },
  lockers: []
};

function emit() {
  listeners.forEach(listener => listener());
}

function setLockers(lockers) {
  const nextLockers = Array.isArray(lockers) ? lockers : [];
  const currentDetailsLocker = state.lockerDetails.locker;
  const nextDetailsLocker = currentDetailsLocker
    ? nextLockers.find(locker => locker.locker === currentDetailsLocker.locker) || currentDetailsLocker
    : null;

  state = {
    ...state,
    lockerDetails: {
      ...state.lockerDetails,
      locker: nextDetailsLocker
    },
    lockers: nextLockers
  };
  emit();
  handlers.onAfterRefresh(state.lockers);
  return state.lockers;
}

function setLockerDetails(patch) {
  state = {
    ...state,
    lockerDetails: {
      ...state.lockerDetails,
      ...patch
    }
  };
  emit();
  return state.lockerDetails;
}

async function loadLockerDetailsLogs(lockerNumber) {
  setLockerDetails({
    error: "",
    loading: true
  });

  try {
    const recentLogs = await apiFetch(`/logs${buildQueryString({ locker: lockerNumber, limit: 8 })}`);
    return setLockerDetails({
      error: "",
      loading: false,
      recentLogs: Array.isArray(recentLogs) ? recentLogs : []
    }).recentLogs;
  } catch (error) {
    setLockerDetails({
      error: error.message,
      loading: false,
      recentLogs: []
    });
    return [];
  }
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

export async function refreshLockersFromStore() {
  try {
    return await refreshLockers();
  } catch (error) {
    handlers.onRefreshError(error);
    return state.lockers;
  }
}

export function clearLockers() {
  state = {
    lockerDetails: {
      error: "",
      loading: false,
      locker: null,
      open: false,
      recentLogs: []
    },
    lockers: []
  };
  emit();
  handlers.onAfterRefresh(state.lockers);
  return state.lockers;
}

export function openLockerFromStore(locker) {
  return handlers.onOpenLocker(locker);
}

export function openLockerDetailsFromStore(locker) {
  setLockerDetails({
    error: "",
    loading: true,
    locker,
    open: true,
    recentLogs: []
  });

  return loadLockerDetailsLogs(locker.locker);
}

export function closeLockerDetailsFromStore() {
  return setLockerDetails({
    error: "",
    loading: false,
    locker: null,
    open: false,
    recentLogs: []
  });
}

export function refreshLockerDetailsFromStore() {
  const locker = state.lockerDetails.locker;
  if (!locker) {
    return Promise.resolve([]);
  }

  const freshLocker = state.lockers.find(item => item.locker === locker.locker) || locker;
  setLockerDetails({ locker: freshLocker });
  return loadLockerDetailsLogs(freshLocker.locker);
}

export function getLockerDetailsLockerNumber() {
  return state.lockerDetails.open ? state.lockerDetails.locker?.locker || null : null;
}

export function releaseAllLockersFromStore() {
  return handlers.onReleaseAll();
}

export function useLockers() {
  return useSyncExternalStore(subscribeLockers, getLockersSnapshot, getLockersSnapshot);
}
