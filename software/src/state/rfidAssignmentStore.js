import { useSyncExternalStore } from "react";
import { apiFetch } from "../services/apiClient.js";
import { showToast } from "./feedbackStore.js";
import { refreshRemoteActions } from "./remoteActionsStore.js";
import { getUiShellSnapshot } from "./uiShellStore.js";

const listeners = new Set();
let state = {
  assignment: null,
  canManage: false,
  draftItemName: "",
  esp32Connected: false,
  isRequestPending: false
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

export function subscribeRfidAssignment(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRfidAssignmentSnapshot() {
  return state;
}

export function syncRfidAssignmentContext(patch = {}) {
  return updateState(patch);
}

export function clearRfidAssignmentState() {
  return updateState({
    assignment: null,
    canManage: false,
    draftItemName: "",
    esp32Connected: false,
    isRequestPending: false
  });
}

export function setRfidAssignmentDraftName(draftItemName) {
  return updateState({ draftItemName });
}

export async function startRfidTagAssignmentFromStore() {
  if (!getUiShellSnapshot().canManageRfid) {
    showToast("Nie masz uprawnień do nadawania tagów RFID.", true);
    return;
  }

  updateState({ isRequestPending: true });

  try {
    const assignment = await apiFetch("/rfid-items/tag-assignment/start", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        itemName: state.draftItemName.trim()
      })
    });

    updateState({
      assignment,
      isRequestPending: false
    });
    showToast("Włączono tryb nadawania taga na master readerze.");
    await refreshRemoteActions();
  } catch (error) {
    updateState({ isRequestPending: false });
    showToast(error.message, true);
  }
}

export async function cancelRfidTagAssignmentFromStore({
  reason = "manual_cancel",
  silentNotFound = false,
  silentSuccess = false
} = {}) {
  if (!getUiShellSnapshot().canManageRfid) {
    showToast("Nie masz uprawnień do anulowania nadawania tagów RFID.", true);
    return;
  }

  if (!state.assignment && !state.isRequestPending) {
    return;
  }

  updateState({ isRequestPending: true });

  try {
    await apiFetch("/rfid-items/tag-assignment/cancel", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ reason })
    });

    updateState({
      assignment: null,
      isRequestPending: false
    });
    if (!silentSuccess) {
      showToast("Anulowano tryb nadawania taga RFID.");
    }
    await refreshRemoteActions();
  } catch (error) {
    updateState({ isRequestPending: false });
    if (silentNotFound && /Nie ma aktywnego zadania/.test(error.message)) {
      updateState({ assignment: null });
      return;
    }
    showToast(error.message, true);
  }
}

export function handleRfidAssignmentButtonFromStore() {
  if (state.assignment?.status === "pending") {
    return cancelRfidTagAssignmentFromStore();
  }

  return startRfidTagAssignmentFromStore();
}

export function getRfidAssignmentViewModel(snapshot = state) {
  const {
    assignment,
    canManage,
    draftItemName,
    esp32Connected,
    isRequestPending
  } = snapshot;
  const hasKnownStatus = ["pending", "completed", "failed"].includes(assignment?.status);
  const isPendingAssignment = assignment?.status === "pending";

  if (!canManage) {
    return {
      buttonDanger: false,
      buttonDisabled: true,
      buttonLabel: "Brak uprawnień",
      statusText: "Nadawanie tagów RFID jest dostępne tylko dla ról master i administrator."
    };
  }

  if (!assignment || !hasKnownStatus) {
    if (!esp32Connected) {
      return {
        buttonDanger: false,
        buttonDisabled: true,
        buttonLabel: "ESP32 offline",
        statusText: "Nadawanie taga jest dostępne tylko wtedy, gdy panel ma aktywne połączenie z ESP32."
      };
    }

    return {
      buttonDanger: false,
      buttonDisabled: isRequestPending,
      buttonLabel: isRequestPending ? "Uruchamianie..." : "Nadaj tag",
      statusText: "Możesz wpisać ID ręcznie albo uruchomić nadawanie na master readerze."
    };
  }

  if (isPendingAssignment) {
    const label = assignment.itemName || draftItemName.trim() || "przedmiotu";
    return {
      buttonDanger: true,
      buttonDisabled: isRequestPending,
      buttonLabel: isRequestPending ? "Anulowanie..." : "Anuluj",
      statusText: `Tryb nadawania jest aktywny. Przyłóż tag do master readera, aby zapisać ID ${assignment.tagId} dla ${label}.`
    };
  }

  if (assignment.status === "completed") {
    return {
      buttonDanger: false,
      buttonDisabled: isRequestPending,
      buttonLabel: "Nadaj tag",
      statusText: `Tag został nadany. Nowe ID: ${assignment.result?.tagId || assignment.tagId}.`
    };
  }

  return {
    buttonDanger: false,
    buttonDisabled: isRequestPending,
    buttonLabel: isRequestPending ? "Czyszczenie..." : "Nadaj tag",
    statusText: `Nadawanie nie powiodło się: ${assignment.result?.error || "nieznany błąd"}.`
  };
}

export function useRfidAssignment() {
  return useSyncExternalStore(subscribeRfidAssignment, getRfidAssignmentSnapshot, getRfidAssignmentSnapshot);
}
