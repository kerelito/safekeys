import { useSyncExternalStore } from "react";
import { apiFetch } from "../services/apiClient.js";

const listeners = new Set();
let state = {
  remoteActions: []
};

function emit() {
  listeners.forEach(listener => listener());
}

function setRemoteActions(remoteActions) {
  state = {
    remoteActions: Array.isArray(remoteActions) ? remoteActions : []
  };
  emit();
  return state.remoteActions;
}

export function subscribeRemoteActions(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRemoteActionsSnapshot() {
  return state;
}

export async function refreshRemoteActions() {
  try {
    return setRemoteActions(await apiFetch("/device/actions/history"));
  } catch (error) {
    return setRemoteActions([]);
  }
}

export function clearRemoteActions() {
  return setRemoteActions([]);
}

export function useRemoteActions() {
  return useSyncExternalStore(subscribeRemoteActions, getRemoteActionsSnapshot, getRemoteActionsSnapshot);
}
