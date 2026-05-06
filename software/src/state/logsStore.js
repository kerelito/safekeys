import { useSyncExternalStore } from "react";
import {
  apiFetch,
  buildQueryString,
  downloadUrl
} from "../services/apiClient.js";

const listeners = new Set();
let handlers = {
  afterClear: async () => {},
  canClear: () => false,
  confirmClear: async () => false,
  openDetails: () => {},
  showToast: () => {}
};
let state = {
  filters: {
    event: "",
    locker: "",
    q: ""
  },
  logEvents: [],
  logs: []
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

function buildLogQueryString(extra = {}) {
  return buildQueryString({
    event: state.filters.event,
    locker: state.filters.locker,
    q: state.filters.q,
    limit: 120,
    ...extra
  });
}

function setLogs(logs) {
  return updateState({
    logs: Array.isArray(logs) ? logs : []
  }).logs;
}

export function configureLogsHandlers(nextHandlers = {}) {
  handlers = {
    ...handlers,
    ...nextHandlers
  };
}

export function subscribeLogs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLogsSnapshot() {
  return state;
}

export async function refreshLogs() {
  try {
    return setLogs(await apiFetch(`/logs${buildLogQueryString()}`));
  } catch (error) {
    handlers.showToast(error.message, true);
    return state.logs;
  }
}

export async function refreshLogEvents() {
  try {
    const logEvents = await apiFetch("/logs/events");
    return updateState({
      logEvents: Array.isArray(logEvents) ? [...logEvents].sort() : []
    }).logEvents;
  } catch (error) {
    return state.logEvents;
  }
}

export function addLogToStore(log) {
  if (!log) {
    return state.logs;
  }

  return setLogs([log, ...state.logs]);
}

export function clearLogsState() {
  return setLogs([]);
}

export function setLogFilter(name, value) {
  if (!Object.prototype.hasOwnProperty.call(state.filters, name)) {
    return state.filters;
  }

  return updateState({
    filters: {
      ...state.filters,
      [name]: value
    }
  }).filters;
}

export function resetLogFilters() {
  return updateState({
    filters: {
      event: "",
      locker: "",
      q: ""
    }
  }).filters;
}

export function hasActiveLogFilters() {
  return Boolean(state.filters.event || state.filters.locker || state.filters.q.trim());
}

export function exportLogsFromStore() {
  downloadUrl(`/logs/export${buildLogQueryString({ limit: 500 })}`);
}

export async function clearLogsFromStore() {
  if (!handlers.canClear()) {
    handlers.showToast("Nie masz uprawnień do czyszczenia logów.", true);
    return;
  }

  const confirmed = await handlers.confirmClear();
  if (!confirmed) {
    return;
  }

  try {
    await apiFetch("/logs/clear", {
      method: "POST"
    });

    clearLogsState();
    handlers.showToast("Logi zostały wyczyszczone.");
    await handlers.afterClear();
  } catch (error) {
    handlers.showToast(error.message, true);
  }
}

export function openLogDetailsFromStore(log, summaryText) {
  handlers.openDetails(log, summaryText);
}

export function useLogs() {
  return useSyncExternalStore(subscribeLogs, getLogsSnapshot, getLogsSnapshot);
}
