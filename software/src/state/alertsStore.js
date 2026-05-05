import { useSyncExternalStore } from "react";
import { apiFetch } from "../services/apiClient.js";

const listeners = new Set();
let state = {
  alerts: []
};

function emit() {
  listeners.forEach(listener => listener());
}

function setAlerts(alerts) {
  state = {
    alerts: Array.isArray(alerts) ? alerts : []
  };
  emit();
  return state.alerts;
}

export function subscribeAlerts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAlertsSnapshot() {
  return state;
}

export async function refreshAlerts() {
  try {
    return setAlerts(await apiFetch("/alerts"));
  } catch (error) {
    return setAlerts([]);
  }
}

export function clearAlerts() {
  return setAlerts([]);
}

export function useAlerts() {
  return useSyncExternalStore(subscribeAlerts, getAlertsSnapshot, getAlertsSnapshot);
}
