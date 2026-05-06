import { useSyncExternalStore } from "react";

const listeners = new Set();
let toastTimeoutId;
let confirmResolver = null;
let state = {
  confirm: {
    confirmLabel: "Potwierdź",
    danger: true,
    message: "Ta akcja wymaga potwierdzenia.",
    open: false,
    title: "Potwierdź operację"
  },
  logDetails: {
    details: [],
    open: false,
    summary: "Szczegółowe informacje o zdarzeniu."
  },
  toast: {
    isError: false,
    message: "",
    visible: false
  }
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

export function subscribeFeedback(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFeedbackSnapshot() {
  return state;
}

export function showToast(message, isError = false) {
  updateState({
    toast: {
      isError,
      message,
      visible: true
    }
  });

  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
  }

  toastTimeoutId = setTimeout(() => {
    updateState({
      toast: {
        ...state.toast,
        visible: false
      }
    });
  }, 2500);
}

export function confirmAction({
  title,
  message,
  confirmLabel = "Potwierdź",
  danger = true
}) {
  updateState({
    confirm: {
      confirmLabel,
      danger,
      message,
      open: true,
      title
    }
  });

  return new Promise(resolve => {
    confirmResolver = resolve;
  });
}

export function closeConfirmDialog(result = false) {
  updateState({
    confirm: {
      ...state.confirm,
      open: false
    }
  });

  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
}

export function openLogDetails(summary, details) {
  updateState({
    logDetails: {
      details: Array.isArray(details) ? details : [],
      open: true,
      summary
    }
  });
}

export function closeLogDetails() {
  updateState({
    logDetails: {
      ...state.logDetails,
      open: false
    }
  });
}

export function useFeedback() {
  return useSyncExternalStore(subscribeFeedback, getFeedbackSnapshot, getFeedbackSnapshot);
}
