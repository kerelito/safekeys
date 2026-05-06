import { useSyncExternalStore } from "react";
import {
  apiFetch,
  downloadUrl
} from "../services/apiClient.js";
import { confirmAction, showToast } from "./feedbackStore.js";
import { refreshLockers } from "./lockersStore.js";
import { setRfidAssignmentDraftName, syncRfidAssignmentContext } from "./rfidAssignmentStore.js";
import { getUiShellSnapshot } from "./uiShellStore.js";

const listeners = new Set();

function createRfidUserForm() {
  return {
    allowedLockers: [],
    id: "",
    name: "",
    submitting: false,
    tagId: ""
  };
}

function createRfidItemForm() {
  return {
    id: "",
    itemType: "brelok",
    name: "",
    submitting: false,
    tagId: ""
  };
}

function createPanelUserForm() {
  return {
    displayName: "",
    id: "",
    password: "",
    role: "admin",
    submitting: false,
    username: ""
  };
}

let state = {
  filters: {
    panelUsers: "",
    rfidItems: "",
    rfidUsers: ""
  },
  forms: {
    panelUser: createPanelUserForm(),
    rfidItem: createRfidItemForm(),
    rfidUser: createRfidUserForm()
  },
  panelUsers: [],
  rfidItems: [],
  rfidUsers: []
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

function updateForms(patch) {
  return updateState({
    forms: {
      ...state.forms,
      ...patch
    }
  }).forms;
}

function setRfidUsers(rfidUsers) {
  const list = Array.isArray(rfidUsers) ? rfidUsers : [];
  updateState({ rfidUsers: list });
  return list;
}

function setRfidItems(rfidItems) {
  const list = Array.isArray(rfidItems) ? rfidItems : [];
  updateState({ rfidItems: list });
  return list;
}

function setPanelUsers(panelUsers) {
  const list = Array.isArray(panelUsers) ? panelUsers : [];
  updateState({ panelUsers: list });
  return list;
}

function updateRfidUserForm(patch) {
  return updateForms({
    rfidUser: {
      ...state.forms.rfidUser,
      ...patch
    }
  }).rfidUser;
}

function updateRfidItemForm(patch) {
  return updateForms({
    rfidItem: {
      ...state.forms.rfidItem,
      ...patch
    }
  }).rfidItem;
}

function updatePanelUserForm(patch) {
  return updateForms({
    panelUser: {
      ...state.forms.panelUser,
      ...patch
    }
  }).panelUser;
}

function canManageRfidConfig() {
  return getUiShellSnapshot().canManageRfid;
}

function canManagePanelUsers() {
  return getUiShellSnapshot().canAccessPanelUsers;
}

function canManageMasterRfid() {
  return canManagePanelUsers();
}

function isMasterRfidItem(item) {
  return ["klucz_master", "karta_master"].includes(item?.itemType);
}

export function subscribeAdminLists(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAdminListsSnapshot() {
  return state;
}

export async function refreshRfidUsers() {
  try {
    return setRfidUsers(await apiFetch("/users"));
  } catch (error) {
    showToast(error.message, true);
    return state.rfidUsers;
  }
}

export async function refreshRfidItems() {
  try {
    return setRfidItems(await apiFetch("/rfid-items"));
  } catch (error) {
    showToast(error.message, true);
    return state.rfidItems;
  }
}

export async function refreshPanelUsers() {
  if (!canManagePanelUsers()) {
    return setPanelUsers([]);
  }

  try {
    return setPanelUsers(await apiFetch("/panel-users"));
  } catch (error) {
    showToast(error.message, true);
    return state.panelUsers;
  }
}

export function clearAdminLists() {
  setRfidAssignmentDraftName("");
  syncRfidAssignmentContext({ assignment: null });
  updateState({
    filters: {
      panelUsers: "",
      rfidItems: "",
      rfidUsers: ""
    },
    forms: {
      panelUser: createPanelUserForm(),
      rfidItem: createRfidItemForm(),
      rfidUser: createRfidUserForm()
    },
    panelUsers: [],
    rfidItems: [],
    rfidUsers: []
  });
}

export function setAdminListFilter(name, value) {
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

export function setRfidUserFormField(name, value) {
  if (!Object.prototype.hasOwnProperty.call(state.forms.rfidUser, name) || name === "allowedLockers" || name === "submitting") {
    return state.forms.rfidUser;
  }

  return updateRfidUserForm({ [name]: value });
}

export function toggleRfidUserLocker(lockerNumber) {
  const numericLocker = Number(lockerNumber);
  const allowedLockers = state.forms.rfidUser.allowedLockers.includes(numericLocker)
    ? state.forms.rfidUser.allowedLockers.filter(locker => locker !== numericLocker)
    : [...state.forms.rfidUser.allowedLockers, numericLocker].sort((left, right) => left - right);

  return updateRfidUserForm({ allowedLockers });
}

export function resetRfidUserFormState() {
  return updateRfidUserForm(createRfidUserForm());
}

export function editRfidUser(user) {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do edycji użytkowników RFID.", true);
    return;
  }

  updateRfidUserForm({
    allowedLockers: Array.isArray(user.allowedLockers) ? user.allowedLockers.map(Number).sort((left, right) => left - right) : [],
    id: user._id || "",
    name: user.name || "",
    submitting: false,
    tagId: user.tagId || ""
  });
}

export async function submitRfidUserFormFromStore() {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do zarządzania użytkownikami RFID.", true);
    return;
  }

  if (state.forms.rfidUser.submitting) {
    return;
  }

  const payload = {
    allowedLockers: state.forms.rfidUser.allowedLockers,
    name: state.forms.rfidUser.name.trim(),
    tagId: state.forms.rfidUser.tagId.trim()
  };

  if (!payload.name || !payload.tagId) {
    showToast("Uzupełnij nazwę użytkownika i ID taga RFID.", true);
    return;
  }

  updateRfidUserForm({ submitting: true });

  try {
    if (state.forms.rfidUser.id) {
      await apiFetch(`/users/${state.forms.rfidUser.id}`, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      showToast("Użytkownik RFID zaktualizowany.");
    } else {
      await apiFetch("/users", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      showToast("Użytkownik RFID dodany.");
    }

    resetRfidUserFormState();
    await refreshRfidUsers();
  } catch (error) {
    updateRfidUserForm({ submitting: false });
    showToast(error.message, true);
  }
}

export async function deleteRfidUserFromStore(user) {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do usuwania użytkowników RFID.", true);
    return;
  }

  const confirmed = await confirmAction({
    title: "Usunąć użytkownika RFID?",
    message: `Użytkownik ${user.name} straci dostęp kartą RFID do przypisanych skrytek.`,
    confirmLabel: "Usuń użytkownika"
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(`/users/${user._id}`, {
      method: "DELETE"
    });
    showToast("Użytkownik RFID usunięty.");
    if (state.forms.rfidUser.id === user._id) {
      resetRfidUserFormState();
    }
    await refreshRfidUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

export function setRfidItemFormField(name, value) {
  if (!Object.prototype.hasOwnProperty.call(state.forms.rfidItem, name) || name === "submitting") {
    return state.forms.rfidItem;
  }

  if (name === "name") {
    setRfidAssignmentDraftName(value);
  }

  return updateRfidItemForm({ [name]: value });
}

export function applyAssignedRfidTagToForm(tagId) {
  return updateRfidItemForm({ tagId: tagId || "" });
}

export function resetRfidItemFormState() {
  setRfidAssignmentDraftName("");
  return updateRfidItemForm(createRfidItemForm());
}

export function editRfidItem(item) {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do edycji przedmiotów RFID.", true);
    return;
  }

  if (isMasterRfidItem(item) && !canManageMasterRfid()) {
    showToast("Tylko użytkownik master może edytować administracyjne tagi RFID.", true);
    return;
  }

  setRfidAssignmentDraftName(item.name || "");
  updateRfidItemForm({
    id: item._id || "",
    itemType: item.itemType || "brelok",
    name: item.name || "",
    submitting: false,
    tagId: item.tagId || ""
  });
}

export async function submitRfidItemFormFromStore() {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do zarządzania przedmiotami RFID.", true);
    return;
  }

  if (state.forms.rfidItem.submitting) {
    return;
  }

  if (isMasterRfidItem(state.forms.rfidItem) && !canManageMasterRfid()) {
    showToast("Tylko użytkownik master może dodawać administracyjne tagi RFID.", true);
    return;
  }

  const payload = {
    itemType: state.forms.rfidItem.itemType,
    name: state.forms.rfidItem.name.trim(),
    tagId: state.forms.rfidItem.tagId.trim()
  };

  if (!payload.name || !payload.tagId) {
    showToast("Uzupełnij nazwę przedmiotu i UID taga RFID.", true);
    return;
  }

  updateRfidItemForm({ submitting: true });

  try {
    if (state.forms.rfidItem.id) {
      await apiFetch(`/rfid-items/${state.forms.rfidItem.id}`, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      showToast("Przedmiot RFID zaktualizowany.");
    } else {
      await apiFetch("/rfid-items", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      showToast("Przedmiot RFID dodany.");
    }

    resetRfidItemFormState();
    syncRfidAssignmentContext({
      assignment: null,
      isRequestPending: false
    });
    await refreshRfidItems();
    await refreshLockers();
  } catch (error) {
    updateRfidItemForm({ submitting: false });
    showToast(error.message, true);
  }
}

export async function deleteRfidItemFromStore(item) {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do usuwania przedmiotów RFID.", true);
    return;
  }

  if (isMasterRfidItem(item) && !canManageMasterRfid()) {
    showToast("Tylko użytkownik master może usuwać administracyjne tagi RFID.", true);
    return;
  }

  const confirmed = await confirmAction({
    title: "Usunąć przedmiot RFID?",
    message: `Przedmiot ${item.name} przestanie być rozpoznawany po czytelnej nazwie w panelu i logach.`,
    confirmLabel: "Usuń przedmiot"
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(`/rfid-items/${item._id}`, {
      method: "DELETE"
    });
    showToast("Przedmiot RFID usunięty.");
    if (state.forms.rfidItem.id === item._id) {
      resetRfidItemFormState();
    }
    await refreshRfidItems();
    await refreshLockers();
  } catch (error) {
    showToast(error.message, true);
  }
}

export function setPanelUserFormField(name, value) {
  if (!Object.prototype.hasOwnProperty.call(state.forms.panelUser, name) || name === "submitting") {
    return state.forms.panelUser;
  }

  return updatePanelUserForm({ [name]: value });
}

export function resetPanelUserFormState() {
  return updatePanelUserForm(createPanelUserForm());
}

export function editPanelUser(user) {
  if (!canManagePanelUsers()) {
    showToast("Ta sekcja jest dostępna tylko dla użytkownika master.", true);
    return;
  }

  updatePanelUserForm({
    displayName: user.displayName || "",
    id: user._id || "",
    password: "",
    role: user.role || "admin",
    submitting: false,
    username: user.username || ""
  });
}

export async function submitPanelUserFormFromStore() {
  if (!canManagePanelUsers()) {
    showToast("Ta sekcja jest dostępna tylko dla użytkownika master.", true);
    return;
  }

  if (state.forms.panelUser.submitting) {
    return;
  }

  const payload = {
    displayName: state.forms.panelUser.displayName.trim(),
    password: state.forms.panelUser.password,
    role: state.forms.panelUser.role,
    username: state.forms.panelUser.username.trim()
  };

  if (!payload.displayName || !payload.username || (!state.forms.panelUser.id && !payload.password)) {
    showToast("Uzupełnij dane użytkownika panelu.", true);
    return;
  }

  updatePanelUserForm({ submitting: true });

  try {
    if (state.forms.panelUser.id) {
      await apiFetch(`/panel-users/${state.forms.panelUser.id}`, {
        method: "PUT",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      showToast("Użytkownik panelu zaktualizowany.");
    } else {
      await apiFetch("/panel-users", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload)
      });
      showToast("Użytkownik panelu dodany.");
    }

    resetPanelUserFormState();
    await refreshPanelUsers();
  } catch (error) {
    updatePanelUserForm({ submitting: false });
    showToast(error.message, true);
  }
}

export async function deletePanelUserFromStore(user) {
  if (!canManagePanelUsers()) {
    showToast("Ta sekcja jest dostępna tylko dla użytkownika master.", true);
    return;
  }

  if (getUiShellSnapshot().currentUsername === user.username) {
    showToast("Nie możesz usunąć aktualnie zalogowanego konta.", true);
    return;
  }

  const confirmed = await confirmAction({
    title: "Usunąć konto panelu?",
    message: `Konto ${user.displayName} utraci możliwość logowania do panelu SafeKeys.`,
    confirmLabel: "Usuń konto"
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(`/panel-users/${user._id}`, {
      method: "DELETE"
    });
    showToast("Użytkownik panelu usunięty.");
    if (state.forms.panelUser.id === user._id) {
      resetPanelUserFormState();
    }
    await refreshPanelUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

export function exportBackupFromStore() {
  if (!canManagePanelUsers()) {
    showToast("Ta sekcja jest dostępna tylko dla użytkownika master.", true);
    return;
  }

  downloadUrl("/export/backup");
}

export function useAdminLists() {
  return useSyncExternalStore(subscribeAdminLists, getAdminListsSnapshot, getAdminListsSnapshot);
}
