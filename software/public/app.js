const THEME_STORAGE_KEY = "locker-theme";
const COMPACT_STORAGE_KEY = "locker-density";
const API = window.location.origin;
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

let activeCodesData = [];
let toastTimeoutId;
let lastHttpOk = true;
let socket = null;
let isAuthenticated = false;
let isGeneratingCode = false;
let currentUser = null;
let currentPage = "dashboard";
let rfidUsersData = [];
let rfidItemsData = [];
let panelUsersData = [];
let systemStatusData = null;
let currentTagAssignment = null;
let lockersData = [];
let logsCount = 0;
let recentLogsData = [];
let alertsData = [];
let remoteActionsData = [];
let returnSessionsData = [];
let returnConfigData = null;
let confirmResolver = null;
let logSearchDebounceId = null;
let selectedLockerDetailsNumber = null;
let isTagAssignmentRequestPending = false;

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

const RFID_ITEM_STATUS_LABELS = {
  IN_LOCKER: "W skrytce",
  CHECKED_OUT: "Wydany",
  RETURN_PENDING: "Zwrot w toku",
  UNKNOWN: "Nieznany",
  CONFLICT: "Konflikt"
};

const RETURN_SESSION_STATUS_LABELS = {
  WAITING_FOR_ITEM: "Oczekuje na przedmiot",
  ITEM_DETECTED: "Przedmiot wykryty",
  WAITING_FOR_DOOR_CLOSE: "Czeka na zamknięcie drzwi",
  COMPLETED: "Zakończony",
  MISMATCH: "Konflikt UID",
  EXPIRED: "Wygasł",
  CANCELLED: "Anulowany",
  BLOCKED: "Zablokowany"
};

const STATUS_ELEMENT_IDS = {
  server: "serverStatus",
  database: "databaseStatus",
  esp32: "esp32Status"
};

const LOCKER_REFRESH_EVENTS = [
  "KEY_REMOVED",
  "KEY_RETURNED",
  "LOCKER_DOOR_OPENED",
  "LOCKER_DOOR_CLOSED",
  "REMOTE_UNLOCK_REQUESTED",
  "REMOTE_RELEASE_ALL_REQUESTED",
  "return_started",
  "return_open_command_sent",
  "return_item_detected",
  "return_completed_rfid_only",
  "return_completed",
  "return_mismatch",
  "return_expired",
  "return_cancelled"
];

const RFID_USER_REFRESH_EVENTS = [
  "RFID_USER_CREATED",
  "RFID_USER_UPDATED",
  "RFID_USER_DELETED"
];

const RFID_ITEM_REFRESH_EVENTS = [
  "RFID_ITEM_CREATED",
  "RFID_ITEM_UPDATED",
  "RFID_ITEM_DELETED",
  "return_started",
  "return_completed_rfid_only",
  "return_completed",
  "return_mismatch",
  "return_expired",
  "return_cancelled",
  "KEY_REMOVED",
  "KEY_RETURNED"
];

const PANEL_USER_REFRESH_EVENTS = [
  "PANEL_USER_CREATED",
  "PANEL_USER_UPDATED",
  "PANEL_USER_DELETED"
];

function formatLockerMask(mask) {
  if (mask == null || mask === "") {
    return "";
  }

  const numericMask = Number(mask);
  if (!Number.isFinite(numericMask)) {
    return String(mask);
  }

  const binaryMask = (numericMask >>> 0).toString(2).padStart(3, "0");
  return `0b${binaryMask}`;
}

function formatLockerList(lockers) {
  if (!Array.isArray(lockers) || lockers.length === 0) {
    return "";
  }

  return lockers.map(locker => `S${locker}`).join(", ");
}

const LOG_EVENT_PRESENTERS = {
  LOCKER_OPENED: log => ({ text: `Odblokowano S${log.locker} kod ${log.code}`, className: "log-success" }),
  INVALID_CODE: log => ({ text: `Błędny kod ${log.code}`, className: "log-error" }),
  CODE_GENERATED: log => ({ text: `Wygenerowano kod ${log.code}`, className: "log-info" }),
  CODE_EMAIL_SENT: log => ({ text: `Wysłano kod ${log.code} na ${log.recipientEmail || "e-mail"}`, className: "log-success" }),
  CODE_EMAIL_FAILED: log => ({ text: `Błąd wysyłki kodu ${log.code}${log.recipientEmail ? ` na ${log.recipientEmail}` : ""}`, className: "log-error" }),
  CODE_DEACTIVATED: log => ({ text: `Dezaktywowano kod ${log.code}`, className: "log-warning" }),
  KEY_REMOVED: log => ({ text: `Wyjęty klucz S${log.locker}${formatLogItemLabel(log)}`, className: "log-warning" }),
  KEY_RETURNED: log => ({ text: `Zwrócony klucz S${log.locker}${formatLogItemLabel(log)}`, className: "log-success" }),
  LOCKER_DOOR_OPENED: log => ({ text: `Otwarte drzwiczki S${log.locker}`, className: "log-warning" }),
  LOCKER_DOOR_CLOSED: log => ({ text: `Domknięte drzwiczki S${log.locker}`, className: "log-success" }),
  REMOTE_UNLOCK_REQUESTED: log => ({ text: `Zdalne otwarcie S${log.locker}`, className: "log-info" }),
  REMOTE_RELEASE_ALL_REQUESTED: () => ({ text: "Zwolniono blokadę wszystkich skrytek", className: "log-warning" }),
  RFID_ACCESS_GRANTED: log => ({ text: `Autoryzowany tag RFID${formatLogItemLabel(log)}`, className: "log-success" }),
  RFID_ACCESS_DENIED: log => ({ text: `Odrzucony tag RFID${formatLogItemLabel(log)}`, className: "log-error" }),
  access_selection_started: log => ({ text: `Rozpoczęto wybór skrytki${log.details?.isMaster ? " dla taga master" : ""}`, className: "log-info" }),
  access_selection_cancelled: () => ({ text: "Anulowano wybór skrytki", className: "log-warning" }),
  access_selection_timeout: () => ({ text: "Wygasł czas wyboru skrytki", className: "log-warning" }),
  access_selection_invalid_locker: log => ({ text: `Odrzucono wybór niedostępnej skrytki${log.locker ? ` S${log.locker}` : ""}`, className: "log-error" }),
  access_selection_open_single: log => ({ text: `Otwarto wybraną skrytkę${log.locker ? ` S${log.locker}` : ""}`, className: "log-success" }),
  access_selection_open_all: log => ({ text: `Otwarto wszystkie dostępne skrytki${formatLockerList(log.details?.lockers) ? `: ${formatLockerList(log.details?.lockers)}` : ""}`, className: "log-success" }),
  access_selection_busy: () => ({ text: "Zignorowano kolejny tag podczas aktywnej sesji wyboru", className: "log-warning" }),
  invalid_selection_key: log => ({ text: `Zignorowano nieprawidłowy klawisz${log.details?.selectionKey ? ` ${log.details.selectionKey}` : ""}`, className: "log-warning" }),
  access_denied_no_lockers: () => ({ text: "Tag nie ma dostępu do żadnej skrytki", className: "log-error" }),
  RFID_USER_CREATED: () => ({ text: "Dodano użytkownika RFID", className: "log-info" }),
  RFID_USER_UPDATED: () => ({ text: "Zaktualizowano użytkownika RFID", className: "log-info" }),
  RFID_USER_DELETED: () => ({ text: "Usunięto użytkownika RFID", className: "log-warning" }),
  RFID_ITEM_CREATED: () => ({ text: "Dodano przedmiot RFID", className: "log-info" }),
  RFID_ITEM_UPDATED: () => ({ text: "Zaktualizowano przedmiot RFID", className: "log-info" }),
  RFID_ITEM_DELETED: () => ({ text: "Usunięto przedmiot RFID", className: "log-warning" }),
  PANEL_USER_CREATED: () => ({ text: "Dodano użytkownika panelu", className: "log-info" }),
  PANEL_USER_UPDATED: () => ({ text: "Zaktualizowano użytkownika panelu", className: "log-info" }),
  PANEL_USER_DELETED: () => ({ text: "Usunięto użytkownika panelu", className: "log-warning" }),
  AUTH_LOGIN: () => ({ text: "Zalogowano operatora", className: "log-success" }),
  AUTH_LOGOUT: () => ({ text: "Wylogowano operatora", className: "log-info" }),
  RFID_TAG_ASSIGNMENT_STARTED: log => ({ text: `Rozpoczęto nadawanie taga RFID${log.itemName ? ` dla ${log.itemName}` : ""}`, className: "log-info" }),
  RFID_TAG_ASSIGNMENT_COMPLETED: log => ({ text: `Nadano tag RFID${formatLogItemLabel(log)}`, className: "log-success" }),
  RFID_TAG_ASSIGNMENT_FAILED: () => ({ text: "Nie udało się nadać taga RFID", className: "log-error" }),
  RFID_TAG_ASSIGNMENT_CANCELLED: log => ({ text: `Anulowano nadawanie taga RFID${log.itemName ? ` dla ${log.itemName}` : ""}`, className: "log-warning" }),
  return_master_scan: log => ({ text: `Master reader: odczyt UID ${log.tagId || ""}`.trim(), className: "log-info" }),
  master_scan_unknown_uid: log => ({ text: `Nieznany tag na master readerze ${log.tagId || ""}`.trim(), className: "log-warning" }),
  master_scan_user_tag: log => ({ text: `Tag użytkownika na master readerze ${log.tagId || ""}`.trim(), className: "log-info" }),
  return_started: log => ({ text: `Rozpoczęto zwrot do S${log.locker}${formatLogItemLabel(log)}`, className: "log-info" }),
  return_open_command_sent: log => ({ text: `Wysłano otwarcie S${log.locker} dla zwrotu`, className: "log-info" }),
  return_item_detected: log => ({ text: `Wykryto oczekiwany UID w S${log.locker}${formatLogItemLabel(log)}`, className: "log-success" }),
  return_completed_rfid_only: log => ({ text: `Zwrot potwierdzony RFID w S${log.locker}${formatLogItemLabel(log)}`, className: "log-success" }),
  return_completed: log => ({ text: `Zwrot zakończony w S${log.locker}${formatLogItemLabel(log)}`, className: "log-success" }),
  return_mismatch: log => ({ text: `Zwrot niezgodny w S${log.locker}`, className: "log-error" }),
  return_expired: log => ({ text: `Zwrot wygasł w S${log.locker}${formatLogItemLabel(log)}`, className: "log-warning" }),
  return_cancelled: log => ({ text: `Zwrot anulowany w S${log.locker}${formatLogItemLabel(log)}`, className: "log-warning" }),
  return_blocked_unknown_uid: log => ({ text: `Zablokowano zwrot nieznanego UID ${log.tagId || ""}`.trim(), className: "log-warning" }),
  return_blocked_no_assignment: log => ({ text: `Brak przypisanej skrytki${formatLogItemLabel(log)}`, className: "log-warning" }),
  return_blocked_item_not_checked_out: log => ({ text: `Przedmiot nie jest wydany${formatLogItemLabel(log)}`, className: "log-warning" }),
  return_blocked_locker_occupied: log => ({ text: `Skrytka S${log.locker} zajęta przy zwrocie`, className: "log-warning" }),
  return_blocked_reader_offline: log => ({ text: `Czytnik S${log.locker} offline przy zwrocie`, className: "log-error" }),
  return_blocked_session_exists: log => ({ text: `Zwrot już trwa${log.locker ? ` dla S${log.locker}` : ""}`, className: "log-warning" }),
  return_blocked_locker_not_ready: log => ({ text: `Skrytka S${log.locker || ""} niegotowa do zwrotu`.trim(), className: "log-warning" })
};

function formatRelativeTime(value) {
  if (!value) {
    return "brak danych";
  }

  const diffMs = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return "przed chwilą";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) {
    return "przed chwilą";
  }

  if (seconds < 60) {
    return `${seconds} s temu`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min temu`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} godz. temu`;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function setHidden(id, hidden) {
  const element = document.getElementById(id);
  if (element) {
    element.classList.toggle("hidden", hidden);
  }
}

function setElementState(id, state) {
  const element = document.getElementById(id);
  if (element) {
    element.dataset.state = state;
  }
}

function formatOptional(value, fallback = "brak danych") {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  return String(value);
}

function formatBytes(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "brak danych";
  }

  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }

  return `${value} B`;
}

function formatDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "brak danych";
  }

  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours} godz. ${minutes} min`;
  }

  return `${minutes} min`;
}

function formatDateTimeInputValue(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function setTileState(valueId, metaId, state, value, meta) {
  setText(valueId, value);
  setText(metaId, meta);

  const tile = document.getElementById(valueId)?.closest(".status-summary-tile");
  if (tile) {
    tile.dataset.state = state;
  }
}

function updateOverviewMetrics() {
  const readyLockers = lockersData.filter(locker => locker.hasTag && locker.isDoorClosed).length;
  const totalLockers = lockersData.length || 3;
  const totalAccessAssignments = rfidUsersData.reduce((sum, user) => {
    const allowedLockers = Array.isArray(user.allowedLockers) ? user.allowedLockers : [];
    return sum + allowedLockers.length;
  }, 0);
  const itemTypes = new Set(rfidItemsData.map(item => item.itemType)).size;
  const masterUsers = panelUsersData.filter(user => user.role === "master").length;
  const rfidTags = rfidUsersData.length + rfidItemsData.length;

  setText("metricReadyLockers", `${readyLockers}/${totalLockers}`);
  setText("metricActiveCodes", String(activeCodesData.length));
  setText("metricRfidUsers", String(rfidUsersData.length));
  setText("metricRfidItems", String(rfidItemsData.length));
  setText("metricRfidTags", String(rfidTags));
  setText("metricAlerts", String(alertsData.length));

  setText("activeCodesCount", String(activeCodesData.length));
  setText("logsCount", String(logsCount));
  setText("remoteActionsCount", String(remoteActionsData.length));
  setText("dashboardRemoteActionsCount", String(remoteActionsData.length));
  setText("activeReturnsCount", String(returnSessionsData.length));
  setText("rfidUsersCount", String(rfidUsersData.length));
  setText("rfidItemsCount", String(rfidItemsData.length));
  setText("panelUsersCount", String(panelUsersData.length));

  setText("rfidUsersSnapshotCount", String(rfidUsersData.length));
  setText("rfidUsersSnapshotAccess", String(totalAccessAssignments));
  setText("rfidItemsSnapshotCount", String(rfidItemsData.length));
  setText("rfidItemsSnapshotTypes", String(itemTypes));
  setText("panelUsersSnapshotCount", String(panelUsersData.length));
  setText("panelUsersSnapshotMasters", String(masterUsers));
}

function updateStatusIndicator(service, { state = "pending", title, summary, lines = [] }) {
  const element = document.getElementById(STATUS_ELEMENT_IDS[service]);
  if (!element) {
    return;
  }

  element.classList.remove("is-online", "is-offline");
  if (state === "online") {
    element.classList.add("is-online");
  } else if (state === "offline") {
    element.classList.add("is-offline");
  }

  const value = element.querySelector(".status-value");
  if (value) {
    value.textContent = state === "online" ? "Online" : state === "offline" ? "Offline" : "Sprawdzanie";
  }

  const popover = element.querySelector(".status-popover");
  popover.innerHTML = "";

  const titleElement = document.createElement("strong");
  titleElement.textContent = title;

  const summaryElement = document.createElement("small");
  summaryElement.textContent = summary;

  popover.appendChild(titleElement);
  popover.appendChild(summaryElement);

  if (lines.length > 0) {
    const linesWrapper = document.createElement("div");
    linesWrapper.className = "status-lines";

    lines.forEach(line => {
      const lineElement = document.createElement("span");
      lineElement.className = "status-line";
      lineElement.textContent = line;
      linesWrapper.appendChild(lineElement);
    });

    popover.appendChild(linesWrapper);
  }
}

function renderSystemStatus() {
  const socketConnected = Boolean(socket?.connected);
  const databaseConnected = Boolean(systemStatusData?.database?.connected);
  const esp32Connected = Boolean(systemStatusData?.esp32?.connected);
  const databaseState = systemStatusData?.database?.state || "unknown";
  const esp32 = systemStatusData?.esp32 || {};

  updateStatusIndicator("server", {
    state: lastHttpOk ? "online" : "offline",
    title: "Serwer",
    summary: lastHttpOk ? "API odpowiada poprawnie." : "Brak odpowiedzi z API.",
    lines: [
      `HTTP API: ${lastHttpOk ? "OK" : "brak odpowiedzi"}`,
      `Socket.IO: ${socketConnected ? "połączony" : "rozłączony"}`
    ]
  });

  updateStatusIndicator("database", {
    state: databaseConnected ? "online" : "offline",
    title: "Baza danych",
    summary: databaseConnected ? "MongoDB jest dostępne." : "MongoDB nie jest dostępne.",
    lines: [
      `Stan połączenia: ${databaseState}`,
      `Ostatnia aktualizacja: ${formatRelativeTime(systemStatusData?.serverTime)}`
    ]
  });

  updateStatusIndicator("esp32", {
    state: esp32Connected ? "online" : "offline",
    title: "ESP32",
    summary: esp32Connected ? "Heartbeat dociera do serwera." : "Brak świeżego heartbeat z urządzenia.",
    lines: [
      `Ostatni kontakt: ${formatRelativeTime(esp32.lastSeenAt)}`,
      `Ping: ${typeof esp32.pingMs === "number" ? `${esp32.pingMs} ms` : "brak danych"}`,
      `WiFi RSSI: ${typeof esp32.wifiRssi === "number" ? `${esp32.wifiRssi} dBm` : "brak danych"}`,
      `IP: ${esp32.ip || "brak danych"}`
    ]
  });

  setTileState(
    "summaryServerState",
    "summaryServerMeta",
    lastHttpOk ? "online" : "offline",
    lastHttpOk ? "Online" : "Offline",
    socketConnected ? "HTTP OK, Socket połączony" : "HTTP OK, Socket rozłączony"
  );
  setTileState(
    "summaryDatabaseState",
    "summaryDatabaseMeta",
    databaseConnected ? "online" : "offline",
    databaseConnected ? "Połączona" : "Brak połączenia",
    `Stan: ${databaseState}`
  );
  setTileState(
    "summaryDeviceState",
    "summaryDeviceMeta",
    esp32Connected ? "online" : "offline",
    esp32Connected ? "Heartbeat OK" : "Brak heartbeat",
    typeof esp32.pingMs === "number" ? `Ping ${esp32.pingMs} ms` : "Ping niedostępny"
  );
  setTileState(
    "summaryHeartbeat",
    "summaryHeartbeatMeta",
    esp32Connected ? "online" : "pending",
    formatRelativeTime(esp32.lastSeenAt),
    esp32.ip ? `ESP32 ${esp32.ip}` : "Czekam na adres urządzenia"
  );

  const healthState = !lastHttpOk || !databaseConnected
    ? "critical"
    : esp32Connected
      ? "online"
      : "warning";
  const healthTitle = !lastHttpOk
    ? "API offline"
    : !databaseConnected
      ? "Baza danych offline"
      : esp32Connected
        ? "System gotowy"
        : "ESP32 offline";
  const healthMeta = !lastHttpOk
    ? "Panel nie otrzymuje odpowiedzi z backendu."
    : !databaseConnected
      ? `MongoDB zgłasza stan: ${databaseState}. Operacje mogą być niedostępne.`
      : esp32Connected
        ? `Ostatni kontakt z urządzeniem: ${formatRelativeTime(esp32.lastSeenAt)}.`
        : `Ostatni kontakt: ${formatRelativeTime(esp32.lastSeenAt)}. Niektóre operacje wykonają się po powrocie połączenia.`;

  setElementState("systemHealthCard", healthState);
  setText("systemHealthTitle", healthTitle);
  setText("systemHealthMeta", healthMeta);
  setHidden("esp32SyncNotice", esp32Connected);

  setText("diagnosticDeviceId", formatOptional(esp32.deviceId));
  setText("diagnosticIp", formatOptional(esp32.ip));
  setText("diagnosticPing", typeof esp32.pingMs === "number" ? `${esp32.pingMs} ms` : "brak danych");
  setText("diagnosticTransport", formatOptional(esp32.transport));
  setText("diagnosticFirmware", formatOptional(esp32.firmware));
  setText("diagnosticUptime", formatDuration(esp32.uptimeMs));
  setText("diagnosticHeap", [
    typeof esp32.freeHeap === "number" ? `wolne ${formatBytes(esp32.freeHeap)}` : "",
    typeof esp32.minFreeHeap === "number" ? `min. ${formatBytes(esp32.minFreeHeap)}` : ""
  ].filter(Boolean).join(", ") || "brak danych");
  setText("diagnosticRssi", typeof esp32.wifiRssi === "number" ? `${esp32.wifiRssi} dBm` : "brak danych");
  setText("diagnosticMasterReader", esp32.masterReaderPresent === true ? "wykryty" : esp32.masterReaderPresent === false ? "brak sygnału" : "brak danych");

  const returnConfig = returnConfigData || systemStatusData?.returns || {};
  const doorSensorsEnabled = returnConfig.doorSensorsEnabled === true;
  setText("diagnosticDoorSensors", doorSensorsEnabled ? "włączone" : "wyłączone");
  setText("diagnosticReturnMode", doorSensorsEnabled ? "RFID + zamknięcie drzwi" : "RFID only");
  setText("diagnosticReturnTimeout", `${returnConfig.returnSessionTimeoutSeconds || 120} s`);

  renderRfidAssignmentStatus();
  renderReturnSessions();
  updateOverviewMetrics();
}

function renderAlerts() {
  const list = document.getElementById("alertsList");
  if (!list) {
    return;
  }

  list.innerHTML = "";
  setText("alertsCount", String(alertsData.length));
  setText("metricAlerts", String(alertsData.length));

  if (alertsData.length === 0) {
    const empty = document.createElement("div");
    empty.className = "alert-item is-info";
    empty.innerHTML = "<strong>System wygląda zdrowo</strong><span>Nie ma teraz alertów wymagających reakcji.</span>";
    list.appendChild(empty);
    return;
  }

  alertsData.forEach(alert => {
    const item = document.createElement("article");
    item.className = `alert-item is-${alert.severity || "info"}`;

    const title = document.createElement("strong");
    title.textContent = alert.title;

    const detail = document.createElement("span");
    detail.textContent = alert.detail;

    const action = document.createElement("small");
    action.textContent = alert.action;

    item.appendChild(title);
    item.appendChild(detail);
    item.appendChild(action);
    list.appendChild(item);
  });

  updateOverviewMetrics();
}

async function loadAlerts() {
  if (!isAuthenticated) {
    return;
  }

  try {
    alertsData = await apiFetch("/alerts");
    renderAlerts();
  } catch (error) {
    alertsData = [];
    renderAlerts();
  }
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
  isTagAssignmentRequestPending = false;
  document.getElementById("authView").classList.remove("hidden");
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("authError").innerText = message;
  document.getElementById("loginPassword").value = "";
  document.getElementById("userChip").classList.add("hidden");

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  systemStatusData = null;
  renderSystemStatus();
}

function showAppView() {
  isAuthenticated = true;
  document.getElementById("authView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
  document.getElementById("authError").innerText = "";
  updateUserChip();
  updateMasterUi();
  setPage(currentPage, false);
}

function updateUserChip() {
  const chip = document.getElementById("userChip");

  if (!currentUser) {
    chip.classList.add("hidden");
    return;
  }

  document.getElementById("userDisplayName").innerText = currentUser.displayName;
  document.getElementById("userUsername").innerText = `@${currentUser.username} · ${getPanelRoleLabel(currentUser.role)}`;
  chip.classList.remove("hidden");
}

function updateMasterUi() {
  const isMaster = Boolean(currentUser?.isMaster);
  const canManageRfid = canManageRfidConfig();
  const canOperate = canOperateLockers();
  document.getElementById("panelUsersMenuLink").classList.toggle("hidden", !isMaster);
  document.querySelectorAll("[data-rfid-admin-only]").forEach(element => {
    element.classList.toggle("hidden", !canManageRfid);
  });
  document.querySelectorAll("[data-rfid-readonly-note]").forEach(element => {
    element.classList.toggle("hidden", canManageRfid);
  });
  document.querySelectorAll("[data-operation-only]").forEach(element => {
    element.classList.toggle("hidden", !canOperate);
  });
  document.querySelectorAll("[data-master-only]").forEach(element => {
    element.classList.toggle("hidden", !isMaster);
  });
  updateRfidItemTypeOptions();
  renderRfidUsers();
  renderRfidItems();

  if (!isMaster && currentPage === "panelUsers") {
    setPage("dashboard");
  }
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

function canManageMasterRfid() {
  return currentUser?.role === "master";
}

function isMasterRfidItem(item) {
  return ["klucz_master", "karta_master"].includes(item?.itemType);
}

function updateRfidItemTypeOptions() {
  const select = document.getElementById("rfidItemType");
  if (!select) {
    return;
  }
  const assignedLocker = document.getElementById("rfidItemAssignedLocker");
  const status = document.getElementById("rfidItemStatus");

  const canUseMasterTypes = canManageMasterRfid();
  select.querySelectorAll("[data-master-option]").forEach(option => {
    option.disabled = !canUseMasterTypes;
    option.hidden = !canUseMasterTypes;
  });

  if (!canUseMasterTypes && isMasterRfidItem({ itemType: select.value })) {
    select.value = "brelok";
  }

  const isMasterType = isMasterRfidItem({ itemType: select.value });
  if (assignedLocker) {
    assignedLocker.required = !isMasterType;
    assignedLocker.disabled = isMasterType;
    if (isMasterType) {
      assignedLocker.value = "";
    }
  }
  if (status) {
    status.disabled = isMasterType;
    if (isMasterType) {
      status.value = "UNKNOWN";
    }
  }
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
      addLog(log);
    }

    if (LOCKER_REFRESH_EVENTS.includes(log.event)) {
      await loadLockers();
      await loadReturnSessions();
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
    currentTagAssignment = assignment;
    isTagAssignmentRequestPending = false;
    renderRfidAssignmentStatus();

    if (assignment?.status === "completed" && assignment?.result?.success && assignment?.result?.tagId) {
      document.getElementById("rfidItemTagId").value = assignment.result.tagId;
      showToast(`Nadano tag ${assignment.result.tagId}.`);
    }

    if (assignment?.status === "failed") {
      showToast(assignment.result?.error || "Nie udało się nadać taga RFID.", true);
      cancelRfidTagAssignment({ reason: "cleanup_after_result", silentSuccess: true, silentNotFound: true });
    }
  });
  socket.on("active-codes-changed", async () => {
    await loadActiveCodes();
  });
  socket.on("return-session-changed", async session => {
    await loadReturnSessions();
    await loadRfidItems();
    await loadAlerts();

    if (session?.status === "COMPLETED") {
      showToast(`Zwrot potwierdzony. Przedmiot znajduje się w skrytce S${session.locker}.`);
    } else if (session?.status === "MISMATCH") {
      showToast("Zwrot niezgodny. Sprawdź UID w skrytce.", true);
    } else if (session?.status === "EXPIRED") {
      showToast("Zwrot nie został potwierdzony w wyznaczonym czasie.", true);
    }
  });
  socket.on("locker-status-changed", async status => {
    if (applyLockerStatusUpdate(status)) {
      renderLockers();
    } else {
      await loadLockers();
    }
    await loadAlerts();

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
    logsCount = 0;
    recentLogsData = [];
    renderEmptyState("logs", "Brak logów do wyświetlenia.");
    renderRecentEvents();
    updateOverviewMetrics();
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

function toggleMenu(forceOpen = null) {
  const drawer = document.getElementById("menuDrawer");
  const shouldOpen = forceOpen === null ? !drawer.classList.contains("is-mobile-open") : forceOpen;
  drawer.classList.toggle("is-mobile-open", shouldOpen);
  document.getElementById("menuButton").setAttribute("aria-expanded", String(shouldOpen));
}

function setPage(page, closeMenu = true) {
  if (page === "panelUsers" && !currentUser?.isMaster) {
    page = "dashboard";
  }

  const pages = {
    dashboard: "Pulpit",
    lockers: "Skrytki",
    access: "Dostępy",
    users: "Użytkownicy RFID",
    items: "Przedmioty RFID",
    logs: "Logi",
    diagnostics: "Diagnostyka",
    panelUsers: "Administracja"
  };
  if (!pages[page]) {
    page = "dashboard";
  }

  currentPage = page;
  Object.keys(pages).forEach(pageName => {
    document.getElementById(`${pageName}Page`)?.classList.toggle("active", page === pageName);
  });
  setText("currentViewTitle", pages[page]);
  setText("currentBreadcrumb", page === "dashboard" ? "SafeKeys" : `SafeKeys / ${pages[page]}`);
  document.querySelectorAll(".menu-link").forEach(link => {
    link.classList.toggle("active", link.dataset.page === page);
  });

  if (closeMenu) {
    toggleMenu(false);
  }
}

function getStoredTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) || "system";
}

function resolveTheme(theme) {
  if (theme === "system") {
    return themeMedia.matches ? "dark" : "light";
  }

  return theme;
}

function updateThemeButton(theme) {
  const button = document.getElementById("themeToggle");
  button.innerText = `Motyw: ${theme}`;
}

function updateThemeColor(resolvedTheme) {
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  metaTheme.setAttribute("content", resolvedTheme === "dark" ? "#101012" : "#f5f5f7");
}

function applyTheme(theme) {
  const resolvedTheme = resolveTheme(theme);
  document.documentElement.dataset.theme = resolvedTheme;
  updateThemeButton(theme);
  updateThemeColor(resolvedTheme);
}

function cycleTheme() {
  const currentTheme = getStoredTheme();
  const nextTheme = currentTheme === "system" ? "dark" : currentTheme === "dark" ? "light" : "system";
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  applyTheme(nextTheme);
}

function getStoredDensity() {
  const stored = localStorage.getItem(COMPACT_STORAGE_KEY);
  if (stored === "compact" || stored === "simple") {
    return "simple";
  }
  return "advanced";
}

function applyDensity(density) {
  const normalizedDensity = density === "simple" ? "simple" : "advanced";
  const legacyDensity = normalizedDensity === "simple" ? "compact" : "comfort";
  document.documentElement.dataset.density = legacyDensity;
  document.documentElement.dataset.viewMode = normalizedDensity;
  document.getElementById("compactToggle").innerText = normalizedDensity === "simple"
    ? "Tryb: prosty"
    : "Tryb: zaawansowany";

  if (normalizedDensity === "simple" && currentPage !== "dashboard") {
    setPage("dashboard");
  }
}

function toggleDensity() {
  const nextDensity = getStoredDensity() === "simple" ? "advanced" : "simple";
  localStorage.setItem(COMPACT_STORAGE_KEY, nextDensity);
  applyDensity(nextDensity);
}

function getSearchValue(id) {
  return (document.getElementById(id)?.value || "").trim().toLowerCase();
}

function matchesSearch(values, query) {
  if (!query) {
    return true;
  }

  return values
    .filter(value => value !== null && value !== undefined)
    .some(value => String(value).toLowerCase().includes(query));
}

function buildQueryString(params = {}) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      query.set(key, String(value).trim());
    }
  });

  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function downloadUrl(path) {
  window.location.href = API + path;
}

async function copyTextToClipboard(value, successMessage = "Skopiowano do schowka.") {
  const text = String(value || "").trim();
  if (!text) {
    showToast("Nie ma czego skopiować.", true);
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    showToast(successMessage);
  } catch (error) {
    showToast("Nie udało się skopiować do schowka.", true);
  }
}

function renderEmptyState(listId, message) {
  const container = document.getElementById(listId);
  container.innerHTML = "";

  const tagName = container.tagName === "UL" ? "li" : "div";
  const empty = document.createElement(tagName);
  empty.className = "empty-state";

  const title = document.createElement("strong");
  title.textContent = "Brak danych";

  const copy = document.createElement("p");
  copy.textContent = message;

  empty.appendChild(title);
  empty.appendChild(copy);
  container.appendChild(empty);
}

function showToast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.innerText = msg;
  t.classList.toggle("is-error", isError);
  t.classList.add("show");

  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
  }

  toastTimeoutId = setTimeout(() => t.classList.remove("show"), 2500);
}

function closeConfirmDialog(result = false) {
  const overlay = document.getElementById("confirmOverlay");
  overlay.classList.add("hidden");

  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
}

function confirmAction({ title, message, confirmLabel = "Potwierdź", danger = true }) {
  const overlay = document.getElementById("confirmOverlay");
  const accept = document.getElementById("confirmAccept");

  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  accept.textContent = confirmLabel;
  accept.classList.toggle("danger", danger);
  overlay.classList.remove("hidden");

  return new Promise(resolve => {
    confirmResolver = resolve;
    accept.focus();
  });
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function summarizeDeliveryError(message) {
  if (typeof message !== "string" || !message.trim()) {
    return "Sprawdź konfigurację SMTP i spróbuj ponownie.";
  }

  return message.length > 120
    ? `${message.slice(0, 117)}...`
    : message;
}

function setGeneratedDeliveryStatus(label = "", variant = "") {
  const status = document.getElementById("generatedDeliveryStatus");

  if (!label) {
    status.className = "delivery-status hidden";
    status.innerText = "";
    return;
  }

  status.className = `delivery-status ${variant}`.trim();
  status.innerText = label;
}

function renderGeneratedCodeResult(data) {
  document.getElementById("generatedCode").innerText = data.code;
  const copyButton = document.getElementById("copyGeneratedCodeButton");
  copyButton.classList.remove("hidden");
  copyButton.dataset.code = data.code;

  const meta = document.getElementById("generatedCodeMeta");
  const expiresAt = formatDateTime(data.expiresAt);
  const delivery = data.emailDelivery;
  const actor = currentUser?.displayName ? ` Wygenerował: ${currentUser.displayName}.` : "";

  if (delivery?.attempted) {
    if (delivery.sent) {
      setGeneratedDeliveryStatus("E-mail wysłany", "success");
      meta.innerText = `Kod do skrytki S${data.locker} wygasa ${expiresAt}. Wysłano go na ${delivery.recipientEmail}.${actor}`;
      return;
    }

    setGeneratedDeliveryStatus("E-mail niewysłany", "warning");
    meta.innerText = `Kod do skrytki S${data.locker} wygasa ${expiresAt}. Nie udało się wysłać go na ${delivery.recipientEmail}. ${summarizeDeliveryError(delivery.error)}${actor}`;
    return;
  }

  setGeneratedDeliveryStatus();
  meta.innerText = `Kod do skrytki S${data.locker} wygasa ${expiresAt}.${actor}`;
}

function updateGenerateButtonLabel(isSubmitting = false) {
  const button = document.getElementById("generateButton");
  const email = document.getElementById("recipientEmail").value.trim();

  if (isSubmitting) {
    button.innerText = email ? "Generowanie i wysyłka..." : "Generowanie...";
    return;
  }

  button.innerText = email ? "Generuj i wyślij" : "Generuj";
}

function createEmailDeliveryChip(codeData) {
  if (!codeData.recipientEmail) {
    return null;
  }

  const chip = document.createElement("span");
  const failedDelivery = Boolean(codeData.emailDeliveryAttempted && !codeData.emailSentAt);

  chip.className = `code-chip ${failedDelivery ? "is-warning" : "is-success"}`;
  chip.textContent = failedDelivery
    ? `E-mail: błąd · ${codeData.recipientEmail}`
    : `E-mail wysłany · ${codeData.recipientEmail}`;

  if (codeData.emailDeliveryError) {
    chip.title = codeData.emailDeliveryError;
  }

  return chip;
}

async function apiFetch(path, options = {}) {
  let res;

  try {
    res = await fetch(API + path, {
      credentials: "same-origin",
      ...options
    });
  } catch (error) {
    lastHttpOk = false;
    renderSystemStatus();
    throw new Error("Brak połączenia z serwerem.");
  }

  let data = null;
  const isJson = res.headers.get("content-type")?.includes("application/json");

  if (isJson) {
    data = await res.json();
  }

  if (!res.ok) {
    if (res.status === 401) {
      showAuthView("Sesja wygasła. Zaloguj się ponownie.");
    }

    if (res.status >= 500) {
      lastHttpOk = false;
      renderSystemStatus();
    }
    throw new Error(data?.error || "Operacja nie powiodła się.");
  }

  lastHttpOk = true;
  renderSystemStatus();

  return data;
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
    loadReturnSessions(),
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

function resetRfidUserForm() {
  document.getElementById("rfidUserId").value = "";
  document.getElementById("rfidUserName").value = "";
  document.getElementById("rfidUserTagId").value = "";
  document.querySelectorAll('input[name="allowedLocker"]').forEach(input => {
    input.checked = false;
  });
  document.getElementById("rfidUserSubmit").textContent = "Dodaj użytkownika";
}

function resetRfidItemForm() {
  document.getElementById("rfidItemId").value = "";
  document.getElementById("rfidItemName").value = "";
  document.getElementById("rfidItemTagId").value = "";
  updateRfidItemTypeOptions();
  document.getElementById("rfidItemType").value = "brelok";
  document.getElementById("rfidItemAssignedLocker").value = "";
  document.getElementById("rfidItemStatus").value = "UNKNOWN";
  updateRfidItemTypeOptions();
  document.getElementById("rfidItemSubmit").textContent = "Dodaj przedmiot";
  renderRfidAssignmentStatus();
}

function resetPanelUserForm() {
  document.getElementById("panelUserId").value = "";
  document.getElementById("panelUserDisplayName").value = "";
  document.getElementById("panelUserUsername").value = "";
  document.getElementById("panelUserPassword").value = "";
  document.getElementById("panelUserRole").value = "admin";
  document.getElementById("panelUserPassword").required = true;
  document.getElementById("panelUserSubmit").textContent = "Dodaj użytkownika";
}

function getSelectedAllowedLockers() {
  return [...document.querySelectorAll('input[name="allowedLocker"]:checked')]
    .map(input => Number(input.value));
}

function populateRfidUserForm(user) {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do edycji użytkowników RFID.", true);
    return;
  }

  document.getElementById("rfidUserId").value = user._id;
  document.getElementById("rfidUserName").value = user.name;
  document.getElementById("rfidUserTagId").value = user.tagId;
  document.querySelectorAll('input[name="allowedLocker"]').forEach(input => {
    input.checked = user.allowedLockers.includes(Number(input.value));
  });
  document.getElementById("rfidUserSubmit").textContent = "Zapisz zmiany";
  setPage("users");
}

function populateRfidItemForm(item) {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do edycji przedmiotów RFID.", true);
    return;
  }

  if (isMasterRfidItem(item) && !canManageMasterRfid()) {
    showToast("Tylko użytkownik master może edytować administracyjne tagi RFID.", true);
    return;
  }

  updateRfidItemTypeOptions();
  document.getElementById("rfidItemId").value = item._id;
  document.getElementById("rfidItemName").value = item.name;
  document.getElementById("rfidItemTagId").value = item.tagId;
  document.getElementById("rfidItemType").value = item.itemType;
  document.getElementById("rfidItemAssignedLocker").value = item.assignedLocker ? String(item.assignedLocker) : "";
  document.getElementById("rfidItemStatus").value = item.status || "UNKNOWN";
  updateRfidItemTypeOptions();
  document.getElementById("rfidItemSubmit").textContent = "Zapisz zmiany";
  setPage("items");
}

function populatePanelUserForm(user) {
  document.getElementById("panelUserId").value = user._id;
  document.getElementById("panelUserDisplayName").value = user.displayName;
  document.getElementById("panelUserUsername").value = user.username;
  document.getElementById("panelUserPassword").value = "";
  document.getElementById("panelUserPassword").required = false;
  document.getElementById("panelUserRole").value = user.role;
  document.getElementById("panelUserSubmit").textContent = "Zapisz zmiany";
  setPage("panelUsers");
}

function getItemTypeLabel(itemType) {
  return RFID_ITEM_TYPE_LABELS[itemType] || "Inne";
}

function getItemStatusLabel(status) {
  return RFID_ITEM_STATUS_LABELS[status] || "Nieznany";
}

function getReturnSessionStatusLabel(status) {
  return RETURN_SESSION_STATUS_LABELS[status] || "Nieznany";
}

function formatCountdown(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function getReturnSessionForLocker(lockerNumber) {
  return returnSessionsData.find(session => Number(session.locker) === Number(lockerNumber)) || null;
}

function describeDetectedItem(data) {
  if (!data?.hasTag) {
    return {
      title: "Brak przedmiotu",
      meta: "Czytnik RFID nie wykrywa teraz żadnego taga w skrytce."
    };
  }

  if (data.detectedItemKnown && data.detectedItemName) {
    const itemType = data.detectedItemType ? getItemTypeLabel(data.detectedItemType) : "Przedmiot RFID";
    return {
      title: `${itemType}: ${data.detectedItemName}`,
      meta: `UID ${data.detectedTagId || "brak danych"}`
    };
  }

  if (data.detectedTagId) {
    return {
      title: `Obcy obiekt: ${data.detectedTagId}`,
      meta: "Tag nie znajduje się na liście zdefiniowanych przedmiotów RFID."
    };
  }

  return {
    title: "Przedmiot RFID obecny",
    meta: "System nie otrzymał jeszcze UID tego przedmiotu."
  };
}

function getLockerItemStatus(locker) {
  if (locker?.itemStatus) {
    return locker.itemStatus;
  }

  if (!locker?.hasTag) {
    return "missing";
  }

  if (locker.detectedItemKnown && locker.detectedItemName) {
    return "known";
  }

  return "unknown";
}

function getLockerItemPresentation(locker) {
  const itemStatus = getLockerItemStatus(locker);

  if (itemStatus === "known") {
    return {
      status: "known",
      stateClass: "known-item",
      iconClass: "good",
      label: "Znany przedmiot",
      value: locker.detectedItemName || locker.itemName || "Zarejestrowany przedmiot",
      meta: locker.detectedItemType ? getItemTypeLabel(locker.detectedItemType) : "Przedmiot RFID"
    };
  }

  if (itemStatus === "missing") {
    return {
      status: "missing",
      stateClass: "missing-item",
      iconClass: "warn",
      label: "Stan",
      value: "Brak klucza",
      meta: "Czytnik RFID nie wykrywa żadnego taga."
    };
  }

  return {
    status: "unknown",
    stateClass: "unknown-item",
    iconClass: "bad",
    label: "Stan",
    value: "Obcy przedmiot",
    meta: locker.detectedTagId ? `UID ${locker.detectedTagId}` : "Nieznany tag RFID"
  };
}

function applyLockerStatusUpdate(status) {
  if (!status?.locker) {
    return false;
  }

  const nextLockers = [...lockersData];
  const index = nextLockers.findIndex(locker => locker.locker === status.locker);
  if (index >= 0) {
    nextLockers[index] = {
      ...nextLockers[index],
      ...status
    };
  } else {
    nextLockers.push(status);
  }

  nextLockers.sort((left, right) => left.locker - right.locker);
  lockersData = nextLockers;
  return true;
}

function renderRfidUsers() {
  const container = document.getElementById("rfidUsersList");
  const query = getSearchValue("rfidUsersSearch");
  const canManage = canManageRfidConfig();
  const getAllowedLockers = user => Array.isArray(user.allowedLockers) ? user.allowedLockers : [];
  const visibleUsers = rfidUsersData.filter(user => matchesSearch([
    user.name,
    user.tagId,
    ...getAllowedLockers(user).map(locker => `s${locker}`),
    ...getAllowedLockers(user).map(locker => `skrytka ${locker}`)
  ], query));

  container.innerHTML = "";
  updateOverviewMetrics();

  if (rfidUsersData.length === 0) {
    renderEmptyState("rfidUsersList", "Dodaj pierwszą osobę i przypisz jej skrytki, aby przygotować dostęp kartą RFID.");
    return;
  }

  if (visibleUsers.length === 0) {
    renderEmptyState("rfidUsersList", "Nie znaleziono użytkowników pasujących do wyszukiwania.");
    return;
  }

  visibleUsers.forEach(user => {
    const row = document.createElement("div");
    row.className = "table-row rfid-user-row";

    const name = document.createElement("strong");
    name.textContent = user.name;

    const tag = document.createElement("span");
    tag.className = "tag-mono";
    tag.textContent = user.tagId;

    const lockers = document.createElement("span");
    const allowedLockers = getAllowedLockers(user);
    lockers.textContent = allowedLockers.length
      ? allowedLockers.map(locker => `S${locker}`).join(", ")
      : "Brak przypisań";

    const lastUsed = document.createElement("span");
    lastUsed.textContent = user.lastUsedAt ? formatRelativeTime(user.lastUsedAt) : "brak danych";

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const copyButton = document.createElement("button");
    copyButton.className = "secondary-button";
    copyButton.type = "button";
    copyButton.textContent = "Kopiuj UID";
    copyButton.addEventListener("click", () => copyTextToClipboard(user.tagId, `Skopiowano UID ${user.tagId}.`));
    actions.appendChild(copyButton);

    if (canManage) {
      const editButton = document.createElement("button");
      editButton.className = "secondary-button";
      editButton.textContent = "Edytuj";
      editButton.addEventListener("click", () => populateRfidUserForm(user));

      const deleteButton = document.createElement("button");
      deleteButton.className = "danger";
      deleteButton.textContent = "Usuń";
      deleteButton.addEventListener("click", () => deleteRfidUser(user._id, user.name));

      actions.appendChild(editButton);
      actions.appendChild(deleteButton);
    }

    row.appendChild(name);
    row.appendChild(tag);
    row.appendChild(lockers);
    row.appendChild(lastUsed);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function renderRfidItems() {
  const container = document.getElementById("rfidItemsList");
  const query = getSearchValue("rfidItemsSearch");
  const canManage = canManageRfidConfig();
  const visibleItems = rfidItemsData.filter(item => matchesSearch([
    item.name,
    item.tagId,
    item.itemType,
    getItemTypeLabel(item.itemType),
    item.assignedLocker ? `s${item.assignedLocker}` : "",
    getItemStatusLabel(item.status)
  ], query));

  container.innerHTML = "";
  updateOverviewMetrics();

  if (rfidItemsData.length === 0) {
    renderEmptyState("rfidItemsList", "Dodaj pierwszy przedmiot RFID, aby system mógł pokazywać czytelne nazwy zamiast samych UID.");
    return;
  }

  if (visibleItems.length === 0) {
    renderEmptyState("rfidItemsList", "Nie znaleziono przedmiotów pasujących do wyszukiwania.");
    return;
  }

  visibleItems.forEach(item => {
    const row = document.createElement("div");
    row.className = "table-row rfid-item-row";

    const name = document.createElement("strong");
    name.textContent = item.name;

    const tag = document.createElement("span");
    tag.className = "tag-mono";
    tag.textContent = item.tagId;

    const typeChip = document.createElement("span");
    typeChip.className = "badge";
    if (isMasterRfidItem(item)) {
      typeChip.classList.add("master-rfid-chip");
    }
    typeChip.textContent = getItemTypeLabel(item.itemType);

    const status = document.createElement("span");
    const itemStatus = item.requiresConfiguration
      ? "UNKNOWN"
      : (item.status || "UNKNOWN");
    status.className = `status-badge is-${itemStatus === "CONFLICT" ? "critical" : itemStatus === "CHECKED_OUT" || itemStatus === "UNKNOWN" || item.requiresConfiguration ? "warning" : "ok"}`;
    status.textContent = item.requiresConfiguration ? "Wymaga konfiguracji" : isMasterRfidItem(item) ? "Administracyjny" : getItemStatusLabel(itemStatus);

    const locker = document.createElement("span");
    locker.textContent = item.assignedLocker ? `S${item.assignedLocker}` : "brak przypisania";

    const lastMovement = document.createElement("span");
    lastMovement.textContent = item.lastMovementAt ? formatRelativeTime(item.lastMovementAt) : item.lastSeenAt ? formatRelativeTime(item.lastSeenAt) : "brak danych";

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const copyButton = document.createElement("button");
    copyButton.className = "secondary-button";
    copyButton.type = "button";
    copyButton.textContent = "Kopiuj UID";
    copyButton.addEventListener("click", () => copyTextToClipboard(item.tagId, `Skopiowano UID ${item.tagId}.`));
    actions.appendChild(copyButton);

    const canEditItem = canManage && (!isMasterRfidItem(item) || canManageMasterRfid());

    if (canEditItem) {
      const editButton = document.createElement("button");
      editButton.className = "secondary-button";
      editButton.textContent = "Edytuj";
      editButton.addEventListener("click", () => populateRfidItemForm(item));

      const deleteButton = document.createElement("button");
      deleteButton.className = "danger";
      deleteButton.textContent = "Usuń";
      deleteButton.addEventListener("click", () => deleteRfidItem(item));

      actions.appendChild(editButton);
      actions.appendChild(deleteButton);
    }

    row.appendChild(name);
    row.appendChild(tag);
    row.appendChild(typeChip);
    row.appendChild(locker);
    row.appendChild(status);
    row.appendChild(lastMovement);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function renderRfidAssignmentStatus() {
  const status = document.getElementById("rfidAssignmentStatus");
  const button = document.getElementById("assignRfidTagButton");
  const itemName = document.getElementById("rfidItemName").value.trim();
  const esp32Connected = Boolean(systemStatusData?.esp32?.connected);
  const isPendingAssignment = currentTagAssignment?.status === "pending";

  button.classList.remove("danger");

  if (!canManageRfidConfig()) {
    status.textContent = "Nadawanie tagów RFID jest dostępne tylko dla ról master i administrator.";
    button.disabled = true;
    button.textContent = "Brak uprawnień";
    return;
  }

  if (!currentTagAssignment || !["pending", "completed", "failed"].includes(currentTagAssignment.status)) {
    if (!esp32Connected) {
      status.textContent = "Nadawanie taga jest dostępne tylko wtedy, gdy panel ma aktywne połączenie z ESP32.";
      button.disabled = true;
      button.textContent = "ESP32 offline";
      return;
    }

    status.textContent = "Możesz wpisać ID ręcznie albo uruchomić nadawanie na master readerze.";
    button.disabled = isTagAssignmentRequestPending;
    button.textContent = isTagAssignmentRequestPending ? "Uruchamianie..." : "Nadaj tag";
    return;
  }

  if (isPendingAssignment) {
    const label = currentTagAssignment.itemName || itemName || "przedmiotu";
    status.textContent = `Tryb nadawania jest aktywny. Przyłóż tag do master readera, aby zapisać ID ${currentTagAssignment.tagId} dla ${label}.`;
    button.disabled = isTagAssignmentRequestPending;
    button.textContent = isTagAssignmentRequestPending ? "Anulowanie..." : "Anuluj";
    button.classList.add("danger");
    return;
  }

  if (currentTagAssignment.status === "completed") {
    status.textContent = `Tag został nadany. Nowe ID: ${currentTagAssignment.result?.tagId || currentTagAssignment.tagId}.`;
    button.disabled = isTagAssignmentRequestPending;
    button.textContent = "Nadaj tag";
    return;
  }

  status.textContent = `Nadawanie nie powiodło się: ${currentTagAssignment.result?.error || "nieznany błąd"}.`;
  button.disabled = isTagAssignmentRequestPending;
  button.textContent = isTagAssignmentRequestPending ? "Czyszczenie..." : "Nadaj tag";
}

function renderPanelUsers() {
  const container = document.getElementById("panelUsersList");
  const query = getSearchValue("panelUsersSearch");
  const visibleUsers = panelUsersData.filter(user => matchesSearch([
    user.displayName,
    user.username,
    user.role,
    getPanelRoleLabel(user.role)
  ], query));

  container.innerHTML = "";
  updateOverviewMetrics();

  if (!currentUser?.isMaster) {
    renderEmptyState("panelUsersList", "Ta sekcja jest dostępna tylko dla użytkownika master.");
    return;
  }

  if (panelUsersData.length === 0) {
    renderEmptyState("panelUsersList", "Nie ma jeszcze dodatkowych kont panelu. Możesz utworzyć operatorów i nadać im role.");
    return;
  }

  if (visibleUsers.length === 0) {
    renderEmptyState("panelUsersList", "Nie znaleziono kont pasujących do wyszukiwania.");
    return;
  }

  visibleUsers.forEach(user => {
    const row = document.createElement("div");
    row.className = "table-row panel-user-row";

    const name = document.createElement("strong");
    name.textContent = user.displayName;

    const username = document.createElement("span");
    username.textContent = `@${user.username}`;

    const roleChip = document.createElement("span");
    roleChip.className = "badge";
    roleChip.textContent = getPanelRoleLabel(user.role);

    const lastLogin = document.createElement("span");
    lastLogin.textContent = user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : "brak danych";

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const editButton = document.createElement("button");
    editButton.className = "secondary-button";
    editButton.textContent = "Edytuj";
    editButton.addEventListener("click", () => populatePanelUserForm(user));

    const deleteButton = document.createElement("button");
    deleteButton.className = "danger";
    deleteButton.textContent = "Usuń";
    deleteButton.disabled = currentUser.username === user.username;
    deleteButton.addEventListener("click", () => deletePanelUser(user._id, user.displayName));

    actions.appendChild(editButton);
    actions.appendChild(deleteButton);

    row.appendChild(name);
    row.appendChild(username);
    row.appendChild(roleChip);
    row.appendChild(lastLogin);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

async function loadRfidUsers() {
  try {
    rfidUsersData = await apiFetch("/users");
    renderRfidUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadRfidItems() {
  try {
    rfidItemsData = await apiFetch("/rfid-items");
    renderRfidItems();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadCurrentTagAssignment() {
  try {
    const data = await apiFetch("/rfid-items/tag-assignment");
    currentTagAssignment = data.assignment || null;
    isTagAssignmentRequestPending = false;
    renderRfidAssignmentStatus();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadPanelUsers() {
  if (!currentUser?.isMaster) {
    panelUsersData = [];
    renderPanelUsers();
    return;
  }

  try {
    panelUsersData = await apiFetch("/panel-users");
    renderPanelUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function submitRfidUserForm(event) {
  event.preventDefault();

  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do zarządzania użytkownikami RFID.", true);
    return;
  }

  const userId = document.getElementById("rfidUserId").value;
  const payload = {
    name: document.getElementById("rfidUserName").value.trim(),
    tagId: document.getElementById("rfidUserTagId").value.trim(),
    allowedLockers: getSelectedAllowedLockers()
  };

  try {
    if (userId) {
      await apiFetch(`/users/${userId}`, {
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

    resetRfidUserForm();
    await loadRfidUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function submitRfidItemForm(event) {
  event.preventDefault();

  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do zarządzania przedmiotami RFID.", true);
    return;
  }

  const itemId = document.getElementById("rfidItemId").value;
  const itemType = document.getElementById("rfidItemType").value;
  const assignedLocker = document.getElementById("rfidItemAssignedLocker").value;
  const status = document.getElementById("rfidItemStatus").value;

  if (isMasterRfidItem({ itemType }) && !canManageMasterRfid()) {
    showToast("Tylko użytkownik master może dodawać administracyjne tagi RFID.", true);
    return;
  }

  if (!isMasterRfidItem({ itemType }) && !assignedLocker) {
    showToast("Przypisz przedmiot do konkretnej skrytki.", true);
    return;
  }

  const payload = {
    name: document.getElementById("rfidItemName").value.trim(),
    tagId: document.getElementById("rfidItemTagId").value.trim(),
    itemType,
    assignedLocker: assignedLocker ? Number(assignedLocker) : null,
    status
  };

  try {
    if (itemId) {
      await apiFetch(`/rfid-items/${itemId}`, {
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

    resetRfidItemForm();
    currentTagAssignment = null;
    await loadRfidItems();
    await loadLockers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function startRfidTagAssignment() {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do nadawania tagów RFID.", true);
    return;
  }

  const itemName = document.getElementById("rfidItemName").value.trim();

  try {
    isTagAssignmentRequestPending = true;
    renderRfidAssignmentStatus();
    currentTagAssignment = await apiFetch("/rfid-items/tag-assignment/start", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ itemName })
    });

    isTagAssignmentRequestPending = false;
    renderRfidAssignmentStatus();
    showToast("Włączono tryb nadawania taga na master readerze.");
    await loadRemoteActions();
  } catch (error) {
    isTagAssignmentRequestPending = false;
    renderRfidAssignmentStatus();
    showToast(error.message, true);
  }
}

async function cancelRfidTagAssignment({ reason = "manual_cancel", silentSuccess = false, silentNotFound = false } = {}) {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do anulowania nadawania tagów RFID.", true);
    return;
  }

  if (!currentTagAssignment && !isTagAssignmentRequestPending) {
    return;
  }

  try {
    isTagAssignmentRequestPending = true;
    renderRfidAssignmentStatus();
    await apiFetch("/rfid-items/tag-assignment/cancel", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ reason })
    });

    currentTagAssignment = null;
    isTagAssignmentRequestPending = false;
    renderRfidAssignmentStatus();
    if (!silentSuccess) {
      showToast("Anulowano tryb nadawania taga RFID.");
    }
    await loadRemoteActions();
  } catch (error) {
    isTagAssignmentRequestPending = false;
    renderRfidAssignmentStatus();
    if (silentNotFound && /Nie ma aktywnego zadania/.test(error.message)) {
      currentTagAssignment = null;
      renderRfidAssignmentStatus();
      return;
    }
    showToast(error.message, true);
  }
}

function handleRfidTagAssignmentButtonClick() {
  if (currentTagAssignment?.status === "pending") {
    cancelRfidTagAssignment();
    return;
  }

  startRfidTagAssignment();
}

async function submitPanelUserForm(event) {
  event.preventDefault();

  const userId = document.getElementById("panelUserId").value;
  const payload = {
    displayName: document.getElementById("panelUserDisplayName").value.trim(),
    username: document.getElementById("panelUserUsername").value.trim(),
    password: document.getElementById("panelUserPassword").value,
    role: document.getElementById("panelUserRole").value
  };

  try {
    if (userId) {
      await apiFetch(`/panel-users/${userId}`, {
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

    resetPanelUserForm();
    await loadPanelUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteRfidUser(userId, name) {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do usuwania użytkowników RFID.", true);
    return;
  }

  const confirmed = await confirmAction({
    title: "Usunąć użytkownika RFID?",
    message: `Użytkownik ${name} straci dostęp kartą RFID do przypisanych skrytek.`,
    confirmLabel: "Usuń użytkownika"
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(`/users/${userId}`, {
      method: "DELETE"
    });
    showToast("Użytkownik RFID usunięty.");
    resetRfidUserForm();
    await loadRfidUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteRfidItem(item) {
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
    resetRfidItemForm();
    await loadRfidItems();
    await loadLockers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deletePanelUser(userId, name) {
  const confirmed = await confirmAction({
    title: "Usunąć konto panelu?",
    message: `Konto ${name} utraci możliwość logowania do panelu SafeKeys.`,
    confirmLabel: "Usuń konto"
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(`/panel-users/${userId}`, {
      method: "DELETE"
    });
    showToast("Użytkownik panelu usunięty.");
    resetPanelUserForm();
    await loadPanelUsers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function generateCode() {
  if (!canOperateLockers()) {
    showToast("Nie masz uprawnień do generowania kodów.", true);
    return;
  }

  if (isGeneratingCode) {
    return;
  }

  const locker = document.getElementById("locker").value;
  const hours = document.getElementById("hours").value;
  const recipientEmailInput = document.getElementById("recipientEmail");
  const recipientEmail = recipientEmailInput.value.trim();
  const generateButton = document.getElementById("generateButton");

  if (recipientEmail && !recipientEmailInput.checkValidity()) {
    recipientEmailInput.reportValidity();
    return;
  }

  isGeneratingCode = true;
  generateButton.disabled = true;
  updateGenerateButtonLabel(true);

  try {
    const data = await apiFetch("/generate-code", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        locker: Number(locker),
        hours: Number(hours),
        recipientEmail
      })
    });

    renderGeneratedCodeResult(data);

    if (data.emailDelivery?.attempted) {
      showToast(
        data.emailDelivery.sent
          ? `Kod wygenerowany i wysłany na ${data.emailDelivery.recipientEmail}.`
          : "Kod wygenerowany, ale wysyłka e-mail nie powiodła się.",
        !data.emailDelivery.sent
      );
    } else {
      showToast("Kod wygenerowany.");
    }

    await loadActiveCodes();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    isGeneratingCode = false;
    generateButton.disabled = false;
    updateGenerateButtonLabel();
  }
}

async function loadLockers() {
  try {
    lockersData = await apiFetch("/lockers");
    renderLockers();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderLockers() {
  const container = document.getElementById("lockers");
  const dashboardContainer = document.getElementById("dashboardLockers");
  if (container) {
    container.innerHTML = "";
    const head = document.createElement("div");
    head.className = "table-head lockers-head";
    ["ID", "Klucz", "Drzwi", "Ostatnio", "Tag / przedmiot", "Akcje"].forEach(label => {
      const cell = document.createElement("span");
      cell.textContent = label;
      head.appendChild(cell);
    });
    container.appendChild(head);
  }
  if (dashboardContainer) {
    dashboardContainer.innerHTML = "";
  }

  lockersData.forEach(locker => {
    const returnSession = getReturnSessionForLocker(locker.locker);
    const itemPresentation = getLockerItemPresentation(locker);
    const severity = getLockerSeverity(locker);
    const keyStatusLabel = returnSession
      ? "Oczekuje na zwrot"
      : itemPresentation.status === "known"
      ? itemPresentation.value
      : itemPresentation.status === "missing"
        ? "Brak"
        : "Obcy przedmiot";
    const lastActivity = locker.detectedAt ? formatRelativeTime(locker.detectedAt) : "brak danych";

    if (dashboardContainer) {
      const item = document.createElement("article");
      item.className = `compact-locker-item state-${severity}`;

      const id = document.createElement("span");
      id.className = "locker-id";
      id.textContent = `S${locker.locker}`;

      const meta = document.createElement("div");
      meta.className = "compact-locker-meta";

      const title = document.createElement("strong");
      title.textContent = returnSession
        ? `Zwrot do S${locker.locker} · ${formatCountdown(returnSession.secondsRemaining)}`
        : `${keyStatusLabel} · ${locker.isDoorClosed ? "drzwi zamknięte" : "drzwi otwarte"}`;

      const detail = document.createElement("span");
      detail.textContent = returnSession
        ? `${returnSession.itemName || "Przedmiot RFID"} · oczekiwany UID ${returnSession.expectedUid || "brak danych"}`
        : itemPresentation.meta;

      meta.appendChild(title);
      meta.appendChild(detail);

      const badge = document.createElement("span");
      badge.className = returnSession
        ? "status-badge is-warning"
        : `status-badge is-${severity === "ok" ? "ok" : severity === "critical" ? "critical" : "warning"}`;
      badge.textContent = returnSession ? "Zwrot" : getLockerSeverityLabel(locker);

      item.appendChild(id);
      item.appendChild(meta);
      item.appendChild(badge);
      dashboardContainer.appendChild(item);
    }

    if (!container) {
      return;
    }

    const row = document.createElement("div");
    row.className = "table-row locker-row";

    const id = document.createElement("strong");
    id.textContent = `S${locker.locker}`;

    const key = document.createElement("span");
    key.textContent = keyStatusLabel;

    const door = document.createElement("span");
    door.className = `status-badge is-${locker.isDoorClosed ? "ok" : "warning"}`;
    door.textContent = returnConfigData?.doorSensorsEnabled === true
      ? (locker.isDoorClosed ? "Zamknięte" : "Otwarte")
      : "Kontaktrony wył.";

    const activity = document.createElement("span");
    activity.textContent = lastActivity;

    const user = document.createElement("span");
    user.textContent = returnSession
      ? `${returnSession.itemName || "Przedmiot"} · ${formatCountdown(returnSession.secondsRemaining)}`
      : locker.detectedTagId || locker.detectedItemName || "brak danych";

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const openButton = document.createElement("button");
    openButton.textContent = "Otwórz";
    openButton.addEventListener("click", () => openLocker(locker.locker));

    const statusButton = document.createElement("button");
    statusButton.className = "secondary-button";
    statusButton.textContent = "Szczegóły";
    statusButton.addEventListener("click", () => openLockerDetails(locker));

    if (canOperateLockers()) {
      actions.appendChild(openButton);
    }
    actions.appendChild(statusButton);

    row.appendChild(id);
    row.appendChild(key);
    row.appendChild(door);
    row.appendChild(activity);
    row.appendChild(user);
    row.appendChild(actions);
    container.appendChild(row);
  });

  updateOverviewMetrics();
}

function getLockerSeverity(locker) {
  if (["ok", "warn", "critical"].includes(locker?.severity)) {
    return locker.severity;
  }

  const itemStatus = getLockerItemStatus(locker);

  if (itemStatus === "unknown") {
    return "critical";
  }
  if (itemStatus === "known" && locker.isDoorClosed) {
    return "ok";
  }
  if (itemStatus === "missing" && !locker.isDoorClosed) {
    return "critical";
  }
  if (itemStatus === "missing") {
    return "warn";
  }
  return "warn";
}

function getLockerSeverityLabel(locker) {
  const severity = getLockerSeverity(locker);
  if (severity === "ok") return "OK";
  if (severity === "critical") return "Błąd";
  if (severity === "warn") return "Ostrzeżenie";
  return "Info";
}

function getLogPresentation(log) {
  const presenter = LOG_EVENT_PRESENTERS[log.event];
  if (presenter) {
    return presenter(log);
  }

  return {
    text: log.event || "Zdarzenie systemowe",
    className: "log-info"
  };
}

function createLogSummaryElement(log) {
  const presentation = getLogPresentation(log);
  const item = document.createElement("button");
  item.type = "button";
  item.className = `locker-history-item ${presentation.className}`;
  item.addEventListener("click", () => openLogDetails(log, presentation.text));

  const title = document.createElement("strong");
  title.textContent = presentation.text;

  const meta = document.createElement("span");
  meta.textContent = log.timestamp ? formatDateTime(log.timestamp) : "brak daty";

  item.appendChild(title);
  item.appendChild(meta);
  return item;
}

function renderRecentEvents() {
  const container = document.getElementById("recentEventsList");
  if (!container) {
    return;
  }

  container.innerHTML = "";

  if (recentLogsData.length === 0) {
    renderEmptyState("recentEventsList", "Brak ostatnich zdarzeń do wyświetlenia.");
    return;
  }

  recentLogsData.slice(0, 6).forEach(log => {
    const presentation = getLogPresentation(log);
    const item = document.createElement("button");
    item.type = "button";
    item.className = `recent-event-item ${presentation.className}`;
    item.addEventListener("click", () => openLogDetails(log, presentation.text));

    const main = document.createElement("div");
    main.className = "recent-event-main";

    const title = document.createElement("strong");
    title.textContent = presentation.text;

    const meta = document.createElement("span");
    meta.textContent = log.timestamp ? formatDateTime(log.timestamp) : "brak daty";

    main.appendChild(title);
    main.appendChild(meta);
    item.appendChild(main);
    container.appendChild(item);
  });
}

function renderLockerDetailsStatus(locker) {
  const status = document.getElementById("lockerDetailsStatus");
  const detectedItem = describeDetectedItem(locker);
  const severity = getLockerSeverity(locker);
  const returnSession = getReturnSessionForLocker(locker.locker);

  status.innerHTML = "";
  [
    ["Stan", returnSession ? "Oczekuje na zwrot" : getLockerSeverityLabel(locker), returnSession ? "warn" : severity],
    ["Klucz", locker.hasTag ? "Obecny" : "Brak", locker.hasTag ? "ok" : "critical"],
    ["Drzwi", returnConfigData?.doorSensorsEnabled === true ? (locker.isDoorClosed ? "Zamknięte" : "Otwarte") : "Kontaktrony wył.", locker.isDoorClosed ? "ok" : "warn"]
  ].forEach(([label, value, state]) => {
    const card = document.createElement("article");
    card.className = `locker-detail-tile state-${state}`;

    const labelElement = document.createElement("span");
    labelElement.textContent = label;

    const valueElement = document.createElement("strong");
    valueElement.textContent = value;

    card.appendChild(labelElement);
    card.appendChild(valueElement);
    status.appendChild(card);
  });

  const item = document.getElementById("lockerDetailsItem");
  item.innerHTML = "";

  const itemTitle = document.createElement("strong");
  itemTitle.textContent = returnSession
    ? `Oczekiwany przedmiot: ${returnSession.itemName || "Przedmiot RFID"}`
    : detectedItem.title;

  const itemMeta = document.createElement("span");
  itemMeta.textContent = returnSession
    ? `UID ${returnSession.expectedUid || "brak danych"} · timeout ${formatCountdown(returnSession.secondsRemaining)}`
    : detectedItem.meta;

  item.appendChild(itemTitle);
  item.appendChild(itemMeta);

  document.getElementById("lockerDetailsSummary").textContent = [
    returnSession ? "trwa zwrot" : null,
    locker.hasTag ? "Klucz jest wykryty" : "Brak wykrytego klucza",
    returnConfigData?.doorSensorsEnabled === true
      ? (locker.isDoorClosed ? "drzwiczki są zamknięte" : "drzwiczki są otwarte")
      : "kontaktrony wyłączone"
  ].filter(Boolean).join(", ");
}

function renderLockerRecentLogs(logs) {
  const container = document.getElementById("lockerDetailsLogs");
  container.innerHTML = "";

  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact-empty";
    empty.innerHTML = "<strong>Brak historii</strong><p>Nie ma jeszcze logów dla tej skrytki.</p>";
    container.appendChild(empty);
    return;
  }

  logs.forEach(log => {
    container.appendChild(createLogSummaryElement(log));
  });
}

async function loadLockerRecentLogs(lockerNumber) {
  const container = document.getElementById("lockerDetailsLogs");
  container.innerHTML = '<div class="empty-state compact-empty"><strong>Ładowanie</strong><p>Pobieram ostatnie zdarzenia skrytki.</p></div>';

  try {
    const logs = await apiFetch(`/logs${buildQueryString({ locker: lockerNumber, limit: 8 })}`);
    renderLockerRecentLogs(logs);
  } catch (error) {
    container.innerHTML = "";
    const failure = document.createElement("div");
    failure.className = "empty-state compact-empty";
    const title = document.createElement("strong");
    const message = document.createElement("p");
    title.textContent = "Nie udało się pobrać logów";
    message.textContent = error.message;
    failure.appendChild(title);
    failure.appendChild(message);
    container.appendChild(failure);
  }
}

function openLockerDetails(locker) {
  selectedLockerDetailsNumber = locker.locker;
  document.getElementById("lockerDetailsTitle").textContent = `Skrytka S${locker.locker}`;
  document.getElementById("lockerDetailsOpen").dataset.locker = String(locker.locker);
  renderLockerDetailsStatus(locker);
  loadLockerRecentLogs(locker.locker);
  document.getElementById("lockerDetailsOverlay").classList.remove("hidden");
}

function closeLockerDetails() {
  selectedLockerDetailsNumber = null;
  document.getElementById("lockerDetailsOverlay").classList.add("hidden");
}

function refreshLockerDetailsFromData() {
  if (!selectedLockerDetailsNumber) {
    return;
  }

  const locker = lockersData.find(item => item.locker === selectedLockerDetailsNumber);
  if (locker) {
    renderLockerDetailsStatus(locker);
    loadLockerRecentLogs(locker.locker);
  }
}

function renderReturnSessions() {
  setText("activeReturnsCount", String(returnSessionsData.length));

  const renderInto = (containerId, limit = 6) => {
    const container = document.getElementById(containerId);
    if (!container) {
      return;
    }

    container.innerHTML = "";

    if (returnSessionsData.length === 0) {
      renderEmptyState(containerId, "Brak aktywnych zwrotów.");
      return;
    }

    returnSessionsData.slice(0, limit).forEach(session => {
      const item = document.createElement("article");
      item.className = "return-session-item";

      const main = document.createElement("div");
      main.className = "return-session-main";

      const title = document.createElement("strong");
      title.textContent = `${session.itemName || "Przedmiot RFID"} → S${session.locker}`;

      const meta = document.createElement("span");
      meta.textContent = `${getReturnSessionStatusLabel(session.status)} · UID ${session.expectedUid || "brak danych"}`;

      main.appendChild(title);
      main.appendChild(meta);

      const timer = document.createElement("span");
      timer.className = "status-badge is-warning";
      timer.textContent = `Timeout ${formatCountdown(session.secondsRemaining)}`;

      item.appendChild(main);
      item.appendChild(timer);
      container.appendChild(item);
    });
  };

  renderInto("activeReturnsList", 4);
  renderInto("diagnosticReturnsList", 8);
  updateOverviewMetrics();
}

async function loadReturnSessions() {
  if (!isAuthenticated) {
    return;
  }

  try {
    const data = await apiFetch("/returns/active");
    returnSessionsData = Array.isArray(data?.sessions) ? data.sessions : [];
    returnConfigData = data?.config || returnConfigData;
    renderReturnSessions();
    renderSystemStatus();
    renderLockers();
  } catch (error) {
    returnSessionsData = [];
    renderReturnSessions();
  }
}

function getRemoteActionTypeLabel(action) {
  if (action.type === "OPEN_LOCKER") {
    return action.locker ? `Otwórz S${action.locker}` : "Otwórz skrytkę";
  }

  if (action.type === "RELEASE_ALL_LOCKERS") {
    return "Zwolnij wszystkie";
  }

  if (action.type === "ASSIGN_RFID_TAG") {
    return "Nadaj tag RFID";
  }

  if (action.type === "CANCEL_RFID_TAG_ASSIGNMENT") {
    return "Anuluj nadawanie RFID";
  }

  return action.type || "Polecenie";
}

function getRemoteActionStatusLabel(status) {
  if (status === "pending") return "Oczekuje";
  if (status === "delivered") return "Dostarczone";
  if (status === "queued") return "W kolejce";
  if (status === "sent") return "Wysłane";
  if (status === "acknowledged") return "Potwierdzone";
  if (status === "applied") return "Wykonane";
  if (status === "failed") return "Błąd";
  return "Nieznany";
}

function renderRemoteActions() {
  setText("remoteActionsCount", String(remoteActionsData.length));
  setText("dashboardRemoteActionsCount", String(remoteActionsData.length));

  const renderInto = (containerId, limit = 8) => {
    const container = document.getElementById(containerId);
    if (!container) {
      return;
    }

    container.innerHTML = "";

    if (remoteActionsData.length === 0) {
      renderEmptyState(containerId, "Nie wysłano jeszcze żadnych poleceń do urządzenia.");
      return;
    }

    remoteActionsData.slice(0, limit).forEach(action => {
      const item = document.createElement("article");
      item.className = `remote-action-item is-${action.status || "queued"}`;

      const main = document.createElement("div");
      main.className = "remote-action-main";

      const title = document.createElement("strong");
      title.textContent = getRemoteActionTypeLabel(action);

      const meta = document.createElement("span");
      const actor = action.actor ? ` · ${action.actor}` : "";
      meta.textContent = `${formatRelativeTime(action.createdAt)}${actor}`;

      main.appendChild(title);
      main.appendChild(meta);

      const status = document.createElement("span");
      status.className = "remote-action-status";
      status.textContent = getRemoteActionStatusLabel(action.status);

      item.appendChild(main);
      item.appendChild(status);
      container.appendChild(item);
    });
  };

  renderInto("remoteActionsList", 12);
  renderInto("dashboardRemoteActionsList", 5);
}

async function loadRemoteActions() {
  if (!isAuthenticated) {
    return;
  }

  try {
    remoteActionsData = await apiFetch("/device/actions/history");
    renderRemoteActions();
    updateOverviewMetrics();
  } catch (error) {
    remoteActionsData = [];
    renderRemoteActions();
  }
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
    activeCodesData = await apiFetch("/active-codes");

    const list = document.getElementById("activeCodes");
    list.innerHTML = "";

    if (activeCodesData.length === 0) {
      renderEmptyState("activeCodes", "Brak aktywnych kodów.");
      updateOverviewMetrics();
      await loadAlerts();
      return;
    }

    activeCodesData.forEach(c => {
      const row = document.createElement("div");
      row.id = "code-" + c.code;
      row.className = "table-row active-code-row";

      const label = document.createElement("span");
      label.className = "code-chip";
      label.textContent = c.code;

      const lockerBadge = document.createElement("span");
      lockerBadge.textContent = `S${c.locker}`;

      const deliveryChip = createEmailDeliveryChip(c);
      const recipient = document.createElement("span");

      if (deliveryChip) {
        recipient.textContent = deliveryChip.textContent;
        recipient.title = deliveryChip.title || "";
      } else {
        recipient.textContent = "Tylko panel";
      }

      const timer = document.createElement("span");
      timer.className = "timer";

      const actions = document.createElement("div");
      actions.className = "row-actions";

      const button = document.createElement("button");
      button.className = "danger subtle-danger";
      button.textContent = "Dezaktywuj";
      button.addEventListener("click", () => deactivate(c.code));

      const copyButton = document.createElement("button");
      copyButton.className = "secondary-button code-copy-button";
      copyButton.type = "button";
      copyButton.textContent = "Kopiuj";
      copyButton.addEventListener("click", () => copyTextToClipboard(c.code, `Skopiowano kod ${c.code}.`));

      actions.appendChild(copyButton);
      if (canOperateLockers()) {
        actions.appendChild(button);
      }

      row.appendChild(label);
      row.appendChild(lockerBadge);
      row.appendChild(recipient);
      row.appendChild(timer);
      row.appendChild(actions);
      list.appendChild(row);
    });

    updateCountdowns();
    updateOverviewMetrics();
    await loadAlerts();
  } catch (error) {
    showToast(error.message, true);
  }
}

function updateCountdowns() {
  activeCodesData.forEach(c => {
    const el = document.getElementById("code-" + c.code);
    if (!el) return;

    const t = new Date(c.expiresAt) - new Date();

    if (t <= 0) {
      el.remove();
      activeCodesData = activeCodesData.filter(item => item.code !== c.code);
      if (activeCodesData.length === 0) {
        renderEmptyState("activeCodes", "Brak aktywnych kodów.");
      }
      updateOverviewMetrics();
      return;
    }

    const s = Math.floor(t / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    el.querySelector(".timer").innerText = `Wygasa za ${h}h ${m}m ${sec}s`;
  });

  if (returnSessionsData.length > 0) {
    returnSessionsData = returnSessionsData.map(session => ({
      ...session,
      secondsRemaining: session.expiresAt
        ? Math.max(0, Math.ceil((new Date(session.expiresAt).getTime() - Date.now()) / 1000))
        : session.secondsRemaining
    }));
    renderReturnSessions();
    renderLockers();
  }
}

async function deactivate(code) {
  if (!canOperateLockers()) {
    showToast("Nie masz uprawnień do dezaktywacji kodów.", true);
    return;
  }

  try {
    await apiFetch("/deactivate-code", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ code })
    });

    showToast("Kod dezaktywowany");
    await loadActiveCodes();
    await loadAlerts();
  } catch (error) {
    showToast(error.message, true);
  }
}

function addLog(log, options = {}) {
  const list = document.getElementById("logs");
  const emptyState = list.querySelector(".empty-state");

  if (emptyState) {
    emptyState.remove();
  }

  const li = document.createElement("li");
  const { text, className } = getLogPresentation(log);

  li.className = `table-row log-row ${className}`;

  const time = document.createElement("span");
  time.textContent = log.timestamp ? formatDateTime(log.timestamp) : "brak daty";

  const event = document.createElement("strong");
  event.textContent = text;

  const locker = document.createElement("span");
  locker.textContent = log.locker ? `S${log.locker}` : "-";

  const tagOrCode = document.createElement("span");
  tagOrCode.className = "tag-mono";
  tagOrCode.textContent = log.tagId || log.code || "-";

  const actor = document.createElement("span");
  actor.textContent = log.actor || log.source || "-";

  const status = document.createElement("span");
  status.className = `status-badge ${className === "log-success" ? "is-success" : className === "log-error" ? "is-error" : className === "log-warning" ? "is-warning" : ""}`;
  status.textContent = className === "log-success"
    ? "OK"
    : className === "log-error"
      ? "Błąd"
      : className === "log-warning"
        ? "Uwaga"
        : "Info";

  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.className = "secondary-button log-details-trigger";
  detailsButton.textContent = "Szczegóły";
  detailsButton.title = "Pokaż szczegóły logu";
  detailsButton.setAttribute("aria-label", "Pokaż szczegóły logu");
  detailsButton.addEventListener("click", () => openLogDetails(log, text));

  li.appendChild(time);
  li.appendChild(event);
  li.appendChild(locker);
  li.appendChild(tagOrCode);
  li.appendChild(actor);
  li.appendChild(status);
  li.appendChild(detailsButton);
  list.prepend(li);
  list.scrollTop = 0;
  if (options.increment !== false) {
    logsCount += 1;
    recentLogsData = [log, ...recentLogsData].slice(0, 12);
    renderRecentEvents();
    updateOverviewMetrics();
  }
}

function openLogDetails(log, summaryText) {
  const overlay = document.getElementById("logDetailsOverlay");
  const summary = document.getElementById("logDetailsSummary");
  const detailsList = document.getElementById("logDetailsList");
  if (!overlay || !summary || !detailsList) {
    return;
  }

  summary.textContent = summaryText;
  detailsList.innerHTML = "";

  const details = buildLogDetails(log);

  details.forEach(([label, value]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    row.appendChild(dt);
    row.appendChild(dd);
    detailsList.appendChild(row);
  });

  overlay.classList.remove("hidden");
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
  const addAccessMask = () => addDetail(details, "Maska dostępnych skrytek", log.details?.accessibleLockersMask, formatLockerMask);
  const addSelectionKey = () => addDetail(details, "Klawisz wyboru", log.details?.selectionKey);
  const addUserId = () => addDetail(details, "ID użytkownika RFID", log.details?.userId);
  const addUserName = () => addDetail(details, "Nazwa użytkownika RFID", log.details?.userName);
  const addMode = () => {
    if (typeof log.details?.isMaster === "boolean") {
      addDetail(details, "Tryb dostępu", log.details.isMaster ? "master" : "użytkownik");
    }
  };
  const addSelectedLockers = () => addDetail(details, "Wybrane skrytki", formatLockerList(log.details?.lockers));
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
      addAccessMask();
      addMode();
      addUserId();
      addActor();
      addSource();
      addSuccess();
      break;
    case "access_selection_started":
    case "access_selection_cancelled":
    case "access_selection_timeout":
    case "access_selection_busy":
    case "invalid_selection_key":
    case "access_denied_no_lockers":
      addLocker();
      addTag();
      addUserName();
      addUserId();
      addAccessMask();
      addMode();
      addSelectionKey();
      addActor();
      addSource();
      addSuccess();
      break;
    case "access_selection_invalid_locker":
    case "access_selection_open_single":
      addLocker();
      addTag();
      addUserName();
      addUserId();
      addAccessMask();
      addMode();
      addSelectionKey();
      addActor();
      addSource();
      addSuccess();
      break;
    case "access_selection_open_all":
      addTag();
      addUserName();
      addUserId();
      addAccessMask();
      addMode();
      addSelectedLockers();
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

function closeLogDetails() {
  const overlay = document.getElementById("logDetailsOverlay");
  if (overlay) {
    overlay.classList.add("hidden");
  }
}

function formatLogItemLabel(log) {
  if (log.itemKnown && log.itemName) {
    const typeLabel = log.itemType ? getItemTypeLabel(log.itemType).toLowerCase() : "przedmiot";
    return ` · ${typeLabel}: ${log.itemName}`;
  }

  if (log.tagId) {
    return ` · obcy obiekt: ${log.tagId}`;
  }

  return "";
}

async function loadLogs() {
  try {
    const logs = await apiFetch(`/logs${getLogQueryString()}`);
    logsCount = logs.length;
    recentLogsData = logs.slice(0, 12);
    renderRecentEvents();

    if (logs.length === 0) {
      renderEmptyState("logs", "Brak logów do wyświetlenia.");
      updateOverviewMetrics();
      return;
    }

    const list = document.getElementById("logs");
    list.innerHTML = "";
    logs.reverse().forEach(log => addLog(log, { increment: false }));
    logsCount = logs.length;
    updateOverviewMetrics();
  } catch (error) {
    showToast(error.message, true);
  }
}

function getLogQueryString(extra = {}) {
  return buildQueryString({
    event: document.getElementById("logEventFilter")?.value || "",
    locker: document.getElementById("logLockerFilter")?.value || "",
    from: formatDateTimeInputValue(document.getElementById("logFromFilter")?.value),
    to: formatDateTimeInputValue(document.getElementById("logToFilter")?.value),
    q: document.getElementById("logSearchInput")?.value || "",
    limit: 120,
    ...extra
  });
}

function hasActiveLogFilters() {
  return Boolean(
    document.getElementById("logEventFilter")?.value
    || document.getElementById("logLockerFilter")?.value
    || document.getElementById("logFromFilter")?.value
    || document.getElementById("logToFilter")?.value
    || document.getElementById("logSearchInput")?.value.trim()
  );
}

async function loadLogEvents() {
  try {
    const events = await apiFetch("/logs/events");
    const select = document.getElementById("logEventFilter");
    const currentValue = select.value;
    select.innerHTML = '<option value="">Wszystkie</option>';

    events.forEach(eventName => {
      const option = document.createElement("option");
      option.value = eventName;
      option.textContent = eventName;
      select.appendChild(option);
    });

    select.value = currentValue;
  } catch (error) {
    // Lista typów logów jest pomocnicza, więc nie blokujemy panelu toastem.
  }
}

function resetLogFilters() {
  document.getElementById("logEventFilter").value = "";
  document.getElementById("logLockerFilter").value = "";
  document.getElementById("logFromFilter").value = "";
  document.getElementById("logToFilter").value = "";
  document.getElementById("logSearchInput").value = "";
  loadLogs();
}

function scheduleLoadLogs() {
  if (logSearchDebounceId) {
    clearTimeout(logSearchDebounceId);
  }

  logSearchDebounceId = setTimeout(loadLogs, 250);
}

function exportLogs() {
  downloadUrl(`/logs/export${getLogQueryString({ limit: 500 })}`);
}

function exportBackup() {
  downloadUrl("/export/backup");
}

async function clearLogs() {
  if (!canManageRfidConfig()) {
    showToast("Nie masz uprawnień do czyszczenia logów.", true);
    return;
  }

  const confirmed = await confirmAction({
    title: "Wyczyścić logi?",
    message: "Ta operacja usunie widoczną historię zdarzeń z bazy danych.",
    confirmLabel: "Wyczyść logi"
  });

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch("/logs/clear", {
      method: "POST"
    });

    logsCount = 0;
    recentLogsData = [];
    renderEmptyState("logs", "Brak logów do wyświetlenia.");
    renderRecentEvents();
    updateOverviewMetrics();
    showToast("Logi zostały wyczyszczone.");
    await loadAlerts();
  } catch (error) {
    showToast(error.message, true);
  }
}

document.getElementById("themeToggle").addEventListener("click", cycleTheme);
document.getElementById("compactToggle").addEventListener("click", toggleDensity);
document.getElementById("menuButton").setAttribute("aria-expanded", "false");
document.getElementById("menuButton").addEventListener("click", () => toggleMenu());
document.getElementById("copyGeneratedCodeButton").addEventListener("click", event => {
  copyTextToClipboard(event.currentTarget.dataset.code, "Skopiowano wygenerowany kod.");
});
document.getElementById("recipientEmail").addEventListener("input", updateGenerateButtonLabel);
document.querySelectorAll(".menu-link").forEach(link => {
  link.addEventListener("click", () => setPage(link.dataset.page));
});
document.getElementById("logoutButton").addEventListener("click", logout);
document.getElementById("rfidUserForm").addEventListener("submit", submitRfidUserForm);
document.getElementById("rfidUserReset").addEventListener("click", resetRfidUserForm);
document.getElementById("rfidItemForm").addEventListener("submit", submitRfidItemForm);
document.getElementById("rfidItemReset").addEventListener("click", resetRfidItemForm);
document.getElementById("assignRfidTagButton").addEventListener("click", handleRfidTagAssignmentButtonClick);
document.getElementById("rfidItemName").addEventListener("input", renderRfidAssignmentStatus);
document.getElementById("rfidItemType").addEventListener("change", updateRfidItemTypeOptions);
document.getElementById("panelUserForm").addEventListener("submit", submitPanelUserForm);
document.getElementById("panelUserReset").addEventListener("click", resetPanelUserForm);
document.getElementById("rfidUsersSearch").addEventListener("input", renderRfidUsers);
document.getElementById("rfidItemsSearch").addEventListener("input", renderRfidItems);
document.getElementById("panelUsersSearch").addEventListener("input", renderPanelUsers);
document.getElementById("logEventFilter").addEventListener("change", loadLogs);
document.getElementById("logLockerFilter").addEventListener("change", loadLogs);
document.getElementById("logFromFilter").addEventListener("change", loadLogs);
document.getElementById("logToFilter").addEventListener("change", loadLogs);
document.getElementById("logSearchInput").addEventListener("input", scheduleLoadLogs);
document.getElementById("logFilterReset").addEventListener("click", resetLogFilters);
document.getElementById("exportLogsButton").addEventListener("click", exportLogs);
document.getElementById("backupExportButton").addEventListener("click", exportBackup);
document.getElementById("refreshRemoteActionsButton").addEventListener("click", loadRemoteActions);
document.getElementById("confirmCancel").addEventListener("click", () => closeConfirmDialog(false));
document.getElementById("confirmAccept").addEventListener("click", () => closeConfirmDialog(true));
document.getElementById("confirmOverlay").addEventListener("click", event => {
  if (event.target.id === "confirmOverlay") {
    closeConfirmDialog(false);
  }
});
document.getElementById("logDetailsClose").addEventListener("click", closeLogDetails);
document.getElementById("logDetailsOverlay").addEventListener("click", event => {
  if (event.target.id === "logDetailsOverlay") {
    closeLogDetails();
  }
});
document.getElementById("lockerDetailsClose").addEventListener("click", closeLockerDetails);
document.getElementById("lockerDetailsRefresh").addEventListener("click", refreshLockerDetailsFromData);
document.getElementById("lockerDetailsOpen").addEventListener("click", async event => {
  const locker = Number(event.currentTarget.dataset.locker);
  if (Number.isInteger(locker)) {
    await openLocker(locker);
    refreshLockerDetailsFromData();
  }
});
document.getElementById("lockerDetailsOverlay").addEventListener("click", event => {
  if (event.target.id === "lockerDetailsOverlay") {
    closeLockerDetails();
  }
});
document.getElementById("loginForm").addEventListener("submit", async event => {
  event.preventDefault();

  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;

  try {
    await login(username, password);
    await initializeDashboard();
    document.getElementById("loginPassword").value = "";
    showToast("Zalogowano pomyślnie.");
  } catch (error) {
    document.getElementById("authError").innerText = error.message;
  }
});

document.addEventListener("click", event => {
  const drawer = document.getElementById("menuDrawer");
  const menuButton = document.getElementById("menuButton");

  if (!drawer.classList.contains("is-mobile-open")) {
    return;
  }

  if (!drawer.contains(event.target) && !menuButton.contains(event.target)) {
    toggleMenu(false);
  }
});

themeMedia.addEventListener("change", () => {
  if (getStoredTheme() === "system") {
    applyTheme("system");
  }
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeLogDetails();
    closeLockerDetails();
    closeConfirmDialog(false);
    toggleMenu(false);
  }
});
updateGenerateButtonLabel();
applyTheme(getStoredTheme());
applyDensity(getStoredDensity());
renderSystemStatus();

window.onload = async () => {
  try {
    const authenticated = await checkSession();

    if (authenticated) {
      await initializeDashboard();
      return;
    }
  } catch (error) {
    document.getElementById("authError").innerText = "Nie udało się sprawdzić sesji.";
  }

  showAuthView();
};

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
