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

function upsertLocker(locker, patch = {}) {
  const current = state.lockers.find(item => item.locker === locker) || {
    locker,
    hasTag: false,
    isDoorClosed: true,
    detectedTagId: null,
    detectedItemName: null,
    detectedItemType: null,
    detectedItemKnown: null,
    detectedAt: null
  };

  const next = {
    ...current
  };

  if (typeof patch.hasTag === "boolean") {
    next.hasTag = patch.hasTag;
    if (!patch.hasTag) {
      next.detectedTagId = null;
      next.detectedItemName = null;
      next.detectedItemType = null;
      next.detectedItemKnown = null;
      next.detectedAt = null;
    } else if (!next.detectedAt) {
      next.detectedAt = new Date().toISOString();
    }
  }

  if (typeof patch.isDoorClosed === "boolean") {
    next.isDoorClosed = patch.isDoorClosed;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "tagId")) {
    next.detectedTagId = patch.tagId || null;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "itemName")) {
    next.detectedItemName = patch.itemName || null;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "itemType")) {
    next.detectedItemType = patch.itemType || null;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "itemKnown")) {
    next.detectedItemKnown = typeof patch.itemKnown === "boolean" ? patch.itemKnown : null;
  }

  const nextLockers = state.lockers.some(item => item.locker === locker)
    ? state.lockers.map(item => (item.locker === locker ? next : item))
    : [...state.lockers, next].sort((left, right) => left.locker - right.locker);

  return setLockers(nextLockers);
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

export function applyLockerStatusUpdate(update = {}) {
  const locker = Number(update?.locker);
  if (!Number.isFinite(locker) || locker <= 0) {
    return state.lockers;
  }

  return upsertLocker(locker, update);
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
