import {
  getActivePage,
  setAuthState,
  setActivePage as setUiActivePage,
  setCurrentUserSummary,
  setOperationAccess,
  setPanelUsersAccess,
  setRfidAdminAccess,
  subscribeUiShell
} from "./state/uiShellStore.js";
import {
  clearActiveCodes,
  configureActiveCodesHandlers,
  pruneExpiredActiveCodes,
  refreshActiveCodes
} from "./state/activeCodesStore.js";
import {
  API,
  apiFetch,
  configureApiClient
} from "./services/apiClient.js";
import {
  clearAlerts,
  refreshAlerts
} from "./state/alertsStore.js";
import {
  applyLockerStatusUpdate,
  clearLockers,
  configureLockersHandlers,
  getLockerDetailsLockerNumber,
  openLockerDetailsFromStore,
  refreshLockerDetailsFromStore,
  refreshLockers
} from "./state/lockersStore.js";
import {
  clearRemoteActions,
  refreshRemoteActions
} from "./state/remoteActionsStore.js";
import {
  addLogToStore,
  clearLogsState,
  configureLogsHandlers,
  hasActiveLogFilters,
  refreshLogEvents,
  refreshLogs
} from "./state/logsStore.js";
import {
  closeLogDetails,
  confirmAction,
  openLogDetails as openLogDetailsOverlay,
  showToast
} from "./state/feedbackStore.js";
import {
  applyAssignedRfidTagToForm,
  clearAdminLists,
  refreshPanelUsers,
  refreshRfidItems,
  refreshRfidUsers
} from "./state/adminListsStore.js";
import {
  clearGeneratedCode,
  configureCodeGeneratorHandlers
} from "./state/codeGeneratorStore.js";
import {
  cancelRfidTagAssignmentFromStore,
  clearRfidAssignmentState,
  syncRfidAssignmentContext
} from "./state/rfidAssignmentStore.js";
import {
  clearSystemStatusState,
  syncSystemStatusContext
} from "./state/systemStatusStore.js";
import {
  clearSessionFields,
  configureSessionHandlers
} from "./state/sessionStore.js";

let lastHttpOk = true;
let socket = null;
let isAuthenticated = false;
let currentUser = null;
let currentPage = getActivePage();
let systemStatusData = null;
let lockersData = [];

const RFID_ITEM_TYPE_LABELS = {
  brelok: "Brelok",
  karta: "Karta",
  inne: "Inne",
  klucz_master: "Klucz master",
  karta_master: "Karta master"
};

const PANEL_ROLE_LABELS = {
  master: "Master",
  admin: "Administrator",
  operator: "Operator",
  viewer: "Podgląd"
};

const LOCKER_REFRESH_EVENTS = [
  "KEY_REMOVED",
  "KEY_RETURNED",
  "LOCKER_DOOR_OPENED",
  "LOCKER_DOOR_CLOSED",
  "REMOTE_UNLOCK_REQUESTED",
  "REMOTE_RELEASE_ALL_REQUESTED"
];

const RFID_USER_REFRESH_EVENTS = [
  "RFID_USER_CREATED",
  "RFID_USER_UPDATED",
  "RFID_USER_DELETED"
];

const RFID_ITEM_REFRESH_EVENTS = [
  "RFID_ITEM_CREATED",
  "RFID_ITEM_UPDATED",
  "RFID_ITEM_DELETED"
];

const PANEL_USER_REFRESH_EVENTS = [
  "PANEL_USER_CREATED",
  "PANEL_USER_UPDATED",
  "PANEL_USER_DELETED"
];

function updateOverviewMetrics() {
}

function renderSystemStatus() {
  syncSystemStatusContext({
    lastHttpOk,
    socketConnected: Boolean(socket?.connected),
    systemStatusData
  });
  renderRfidAssignmentStatus();
  updateOverviewMetrics();
}

async function loadAlerts() {
  if (!isAuthenticated) {
    return;
  }

  await refreshAlerts();
}

async function refreshSystemStatus() {
  if (!isAuthenticated) {
    return;
  }

  try {
    systemStatusData = await apiFetch("/system-status");
  } catch (error) {
    systemStatusData = null;
  }

  renderSystemStatus();
  await loadAlerts();
}

function showAuthView(message = "") {
  isAuthenticated = false;
  currentUser = null;
  clearSessionFields();

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  systemStatusData = null;
  setAuthState({ authError: message, isAuthenticated: false });
  setPanelUsersAccess(false);
  setRfidAdminAccess(false);
  setOperationAccess(false);
  setCurrentUserSummary();
  clearActiveCodes();
  clearAdminLists();
  clearAlerts();
  clearGeneratedCode();
  clearLockers();
  clearLogsState();
  clearRemoteActions();
  clearRfidAssignmentState();
  clearSystemStatusState();
  renderSystemStatus();
}

function showAppView() {
  isAuthenticated = true;
  setAuthState({ authError: "", isAuthenticated: true });
  updateMasterUi();
  setPage(currentPage, false);
}

function updateMasterUi() {
  const isMaster = Boolean(currentUser?.isMaster);
  const canManageRfid = canManageRfidConfig();
  const canOperate = canOperateLockers();
  setPanelUsersAccess(isMaster);
  setRfidAdminAccess(canManageRfid);
  setOperationAccess(canOperate);
  setCurrentUserSummary({
    displayName: currentUser?.displayName || "",
    roleLabel: currentUser ? getPanelRoleLabel(currentUser.role) : "",
    username: currentUser?.username || ""
  });
  currentPage = getActivePage();
  renderRfidAssignmentStatus();
}

function getPanelRoleLabel(role) {
  return PANEL_ROLE_LABELS[role] || "Podgląd";
}

function canOperateLockers() {
  return ["master", "admin", "operator"].includes(currentUser?.role);
}

function canManageRfidConfig() {
  return ["master", "admin"].includes(currentUser?.role);
}

function connectSocket() {
  if (socket) {
    return;
  }

  socket = io(API, { withCredentials: true });

  socket.on("new-log", async log => {
    if (hasActiveLogFilters()) {
      await loadLogs();
    } else {
      addLogToStore(log);
    }

    if (LOCKER_REFRESH_EVENTS.includes(log.event)) {
      await loadLockers();
      const selectedLockerDetailsNumber = getLockerDetailsLockerNumber();
      if (selectedLockerDetailsNumber && (!log.locker || log.locker === selectedLockerDetailsNumber)) {
        refreshLockerDetailsFromData();
      }
    }

    if (RFID_USER_REFRESH_EVENTS.includes(log.event)) {
      await loadRfidUsers();
    }

    if (RFID_ITEM_REFRESH_EVENTS.includes(log.event)) {
      await loadRfidItems();
    }

    if (PANEL_USER_REFRESH_EVENTS.includes(log.event) && currentUser?.isMaster) {
      await loadPanelUsers();
    }

    await loadAlerts();
  });
  socket.on("rfid-tag-assignment-updated", assignment => {
    syncRfidAssignmentContext({
      assignment,
      isRequestPending: false
    });
    renderRfidAssignmentStatus();

    if (assignment?.status === "completed" && assignment?.result?.success && assignment?.result?.tagId) {
      applyAssignedRfidTagToForm(assignment.result.tagId);
      showToast(`Nadano tag ${assignment.result.tagId}.`);
    }

    if (assignment?.status === "failed") {
      showToast(assignment.result?.error || "Nie udało się nadać taga RFID.", true);
      cancelRfidTagAssignmentFromStore({
        reason: "cleanup_after_result",
        silentSuccess: true,
        silentNotFound: true
      });
    }
  });
  socket.on("active-codes-changed", async () => {
    await loadActiveCodes();
  });
  socket.on("locker-status-changed", async status => {
    applyLockerStatusUpdate(status);
    await loadLockers();
    await loadAlerts();

    const selectedLockerDetailsNumber = getLockerDetailsLockerNumber();
    if (selectedLockerDetailsNumber && (!status?.locker || status.locker === selectedLockerDetailsNumber)) {
      refreshLockerDetailsFromData();
    }
  });
  socket.on("remote-action-queued", async () => {
    await loadRemoteActions();
  });
  socket.on("remote-action-updated", async () => {
    await loadRemoteActions();
  });
  socket.on("logs-cleared", () => {
    clearLogsState();
    loadAlerts();
  });
  socket.on("connect", () => {
    renderSystemStatus();
    refreshSystemStatus();
  });
  socket.on("system-status", payload => {
    systemStatusData = payload;
    renderSystemStatus();
    loadAlerts();
  });
  socket.on("disconnect", () => {
    renderSystemStatus();
  });
  socket.on("connect_error", () => {
    renderSystemStatus();
  });
}

function setPage(page, closeMenu = true) {
  currentPage = setUiActivePage(page, { closeMenu });
  return currentPage;
}

async function checkSession() {
  const data = await apiFetch("/auth/session");
  if (data.authenticated) {
    currentUser = {
      username: data.username,
      displayName: data.displayName,
      role: data.role,
      isMaster: data.isMaster
    };
  }

  return data.authenticated;
}

async function login(username, password) {
  const data = await apiFetch("/auth/login", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ username, password })
  });

  currentUser = {
    username: data.username,
    displayName: data.displayName,
    role: data.role,
    isMaster: data.isMaster
  };
}

async function logout() {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } finally {
    showAuthView();
  }
}

async function initializeDashboard() {
  showAppView();
  connectSocket();
  await Promise.all([
    refreshSystemStatus(),
    loadLockers(),
    loadActiveCodes(),
    loadAlerts(),
    loadRemoteActions(),
    loadLogEvents(),
    loadLogs(),
    loadRfidUsers(),
    loadRfidItems(),
    loadCurrentTagAssignment(),
    currentUser?.isMaster ? loadPanelUsers() : Promise.resolve()
  ]);
}

function getItemTypeLabel(itemType) {
  return RFID_ITEM_TYPE_LABELS[itemType] || "Inne";
}

function renderRfidAssignmentStatus() {
  syncRfidAssignmentContext({
    canManage: canManageRfidConfig(),
    esp32Connected: Boolean(systemStatusData?.esp32?.connected)
  });
}

async function loadRfidUsers() {
  try {
    await refreshRfidUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadRfidItems() {
  try {
    await refreshRfidItems();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadCurrentTagAssignment() {
  try {
    const data = await apiFetch("/rfid-items/tag-assignment");
    syncRfidAssignmentContext({
      assignment: data.assignment || null,
      isRequestPending: false
    });
    renderRfidAssignmentStatus();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadPanelUsers() {
  try {
    await refreshPanelUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadLockers() {
  if (!isAuthenticated) {
    return;
  }

  try {
    await refreshLockers();
  } catch (error) {
    showToast(error.message, true);
  }
}

function openLockerDetails(locker) {
  return openLockerDetailsFromStore(locker);
}

function refreshLockerDetailsFromData() {
  return refreshLockerDetailsFromStore();
}

async function loadRemoteActions() {
  if (!isAuthenticated) {
    return;
  }

  await refreshRemoteActions();
}

async function openLocker(locker) {
  if (!canOperateLockers()) {
    showToast("Nie masz uprawnień do otwierania skrytek.", true);
    return;
  }

  try {
    await apiFetch("/open-locker", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ locker })
    });

    showToast(`Wysłano polecenie otwarcia S${locker}`);
    await loadLockers();
    await loadAlerts();
    await loadRemoteActions();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function releaseAllLockers() {
  if (!canOperateLockers()) {
    showToast("Nie masz uprawnień do zwalniania skrytek.", true);
    return;
  }

  const confirmed = await confirmAction({
    title: "Zwolnić wszystkie skrytki?",
    message: "To wyśle do urządzenia polecenie zwolnienia blokady wszystkich skrytek.",
    confirmLabel: "Zwolnij wszystkie"
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch("/release-all-lockers", {
      method: "POST"
    });

    showToast("Wysłano polecenie zwolnienia wszystkich skrytek.");
    await loadLockers();
    await loadAlerts();
    await loadRemoteActions();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadActiveCodes() {
  try {
    await refreshActiveCodes();
    updateOverviewMetrics();
    await loadAlerts();
  } catch (error) {
    showToast(error.message, true);
  }
}

function updateCountdowns() {
  pruneExpiredActiveCodes();
  updateOverviewMetrics();
}

function openLogDetails(log, summaryText) {
  openLogDetailsOverlay(summaryText, buildLogDetails(log));
}

function addDetail(details, label, value, formatter = value => value) {
  if (value === undefined || value === null || value === "") {
    return;
  }

  details.push([label, formatter(value)]);
}

function formatBoolean(value) {
  return value ? "tak" : "nie";
}

function formatIsoDateTime(value) {
  return value ? new Date(value).toLocaleString() : "";
}

function formatLogItemDetails(log) {
  if (log.itemKnown && log.itemName) {
    return `${log.itemName} (${getItemTypeLabel(log.itemType || "inne")})`;
  }

  if (log.itemKnown === false && log.tagId) {
    return "Nieznany przedmiot RFID";
  }

  return "";
}

function buildLogDetails(log) {
  const details = [];
  addDetail(details, "Data i czas", log.timestamp, formatIsoDateTime);
  addDetail(details, "Typ zdarzenia", log.event);

  const addCode = () => addDetail(details, "Kod", log.code);
  const addLocker = () => addDetail(details, "Skrytka", log.locker, locker => `S${locker}`);
  const addActor = () => addDetail(details, "Operator / źródło akcji", log.actor);
  const addSource = () => addDetail(details, "Kanał", log.source);
  const addTag = () => addDetail(details, "Tag RFID", log.tagId);
  const addItem = () => addDetail(details, "Rozpoznany przedmiot", formatLogItemDetails(log));
  const addEmail = () => addDetail(details, "Adres e-mail", log.recipientEmail);
  const addError = () => addDetail(details, "Komunikat błędu", log.errorMessage);
  const addSuccess = () => {
    if (typeof log.success === "boolean") {
      addDetail(details, "Sukces operacji", log.success, formatBoolean);
    }
  };

  switch (log.event) {
    case "LOCKER_OPENED":
      addLocker();
      addCode();
      addEmail();
      addActor();
      addSource();
      addSuccess();
      break;
    case "INVALID_CODE":
      addCode();
      addActor();
      addSource();
      addDetail(details, "Powód", log.details?.reason === "code_not_found_or_inactive" ? "Kod nie istnieje, wygasł albo został dezaktywowany" : log.details?.reason);
      addSuccess();
      break;
    case "CODE_GENERATED":
      addLocker();
      addCode();
      addEmail();
      addDetail(details, "Ważny do", log.details?.expiresAt, formatIsoDateTime);
      addDetail(details, "Czas aktywności", log.details?.hours, hours => `${hours} h`);
      addActor();
      addSource();
      break;
    case "CODE_EMAIL_SENT":
      addLocker();
      addCode();
      addEmail();
      addDetail(details, "Wysłano o", log.details?.sentAt, formatIsoDateTime);
      addDetail(details, "Kod ważny do", log.details?.expiresAt, formatIsoDateTime);
      addActor();
      addSource();
      break;
    case "CODE_EMAIL_FAILED":
      addLocker();
      addCode();
      addEmail();
      addError();
      addDetail(details, "Kod ważny do", log.details?.expiresAt, formatIsoDateTime);
      addActor();
      addSource();
      break;
    case "CODE_DEACTIVATED":
      addLocker();
      addCode();
      addEmail();
      addDetail(details, "Kod był ważny do", log.details?.expiresAt, formatIsoDateTime);
      addActor();
      addSource();
      break;
    case "KEY_REMOVED":
    case "KEY_RETURNED":
      addLocker();
      addTag();
      addItem();
      addActor();
      addSource();
      break;
    case "LOCKER_DOOR_OPENED":
    case "LOCKER_DOOR_CLOSED":
      addLocker();
      addActor();
      addSource();
      break;
    case "REMOTE_UNLOCK_REQUESTED":
      addLocker();
      addDetail(details, "ID polecenia", log.details?.actionId);
      addActor();
      addSource();
      break;
    case "REMOTE_RELEASE_ALL_REQUESTED":
      addDetail(details, "ID polecenia", log.details?.actionId);
      addActor();
      addSource();
      break;
    case "RFID_ACCESS_GRANTED":
    case "RFID_ACCESS_DENIED":
      addTag();
      addItem();
      addActor();
      addSource();
      addSuccess();
      break;
    case "RFID_TAG_ASSIGNMENT_STARTED":
      addTag();
      addDetail(details, "Nazwa przedmiotu", log.itemName);
      addDetail(details, "ID zadania", log.details?.assignmentId);
      addActor();
      addSource();
      break;
    case "RFID_TAG_ASSIGNMENT_CANCELLED":
      addTag();
      addDetail(details, "Nazwa przedmiotu", log.itemName);
      addDetail(details, "ID zadania", log.details?.assignmentId);
      addDetail(details, "Anulowano o", log.details?.cancelledAt, formatIsoDateTime);
      addDetail(details, "Powód", log.details?.reason);
      addActor();
      addSource();
      break;
    case "RFID_TAG_ASSIGNMENT_COMPLETED":
    case "RFID_TAG_ASSIGNMENT_FAILED":
      addTag();
      addDetail(details, "Fizyczny UID", log.details?.physicalUid);
      addDetail(details, "Nazwa przedmiotu", log.itemName);
      addDetail(details, "ID zadania", log.details?.assignmentId);
      addDetail(details, "Zakończono o", log.details?.completedAt, formatIsoDateTime);
      addError();
      addActor();
      addSource();
      break;
    default:
      addLocker();
      addCode();
      addTag();
      addItem();
      addEmail();
      addError();
      addActor();
      addSource();
      addSuccess();
      break;
  }

  return details;
}

async function loadLogs() {
  if (!isAuthenticated) {
    return;
  }

  await refreshLogs();
}

async function loadLogEvents() {
  if (!isAuthenticated) {
    return;
  }

  await refreshLogEvents();
}

async function initializeAppSession() {
  try {
    const authenticated = await checkSession();

    if (authenticated) {
      await initializeDashboard();
      return;
    }
  } catch (error) {
    showAuthView("Nie udało się sprawdzić sesji.");
    return;
  }

  showAuthView();
}

export function bootLegacyApp() {
if (window.__safeKeysLegacyAppBooted) {
  return;
}

window.__safeKeysLegacyAppBooted = true;

configureApiClient({
  onHttpStatusChange(ok) {
    lastHttpOk = ok;
    renderSystemStatus();
  },
  onUnauthorized() {
    showAuthView("Sesja wygasła. Zaloguj się ponownie.");
  }
});

configureActiveCodesHandlers({
  canDeactivate: canOperateLockers,
  showToast,
  async afterChange() {
    updateOverviewMetrics();
    await loadAlerts();
  }
});

configureCodeGeneratorHandlers({
  canGenerate: canOperateLockers,
  showToast,
  async afterGenerate() {
    await loadActiveCodes();
  }
});

configureSessionHandlers({
  onLogout: logout,
  async onSubmit({ password, username }) {
    await login(username, password);
    await initializeDashboard();
    showToast("Zalogowano pomyślnie.");
  }
});

configureLockersHandlers({
  onAfterRefresh(lockers) {
    lockersData = lockers;
    updateOverviewMetrics();
  },
  onRefreshError(error) {
    showToast(error.message, true);
  },
  onOpenLocker: openLocker,
  onOpenDetails: openLockerDetails,
  onReleaseAll: releaseAllLockers
});

configureLogsHandlers({
  canClear: canManageRfidConfig,
  showToast,
  confirmClear: () => confirmAction({
    title: "Wyczyścić logi?",
    message: "Ta operacja usunie widoczną historię zdarzeń z bazy danych.",
    confirmLabel: "Wyczyść logi"
  }),
  openDetails: openLogDetails,
  async afterClear() {
    await loadAlerts();
  }
});

subscribeUiShell(() => {
  currentPage = getActivePage();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeLogDetails();
  }
});
renderSystemStatus();

initializeAppSession();

setInterval(() => {
  if (isAuthenticated) {
    updateCountdowns();
  }
}, 1000);
setInterval(() => {
  if (isAuthenticated) {
    loadLockers();
  }
}, 30000);
setInterval(() => {
  if (isAuthenticated) {
    refreshSystemStatus();
  }
}, 30000);
}
