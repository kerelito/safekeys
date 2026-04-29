const THEME_STORAGE_KEY = "locker-theme";
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

const RFID_ITEM_TYPE_LABELS = {
  brelok: "Brelok",
  karta: "Karta",
  inne: "Inne"
};

const STATUS_ELEMENT_IDS = {
  server: "serverStatus",
  database: "databaseStatus",
  esp32: "esp32Status"
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

  renderRfidAssignmentStatus();
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
}

function showAuthView(message = "") {
  isAuthenticated = false;
  currentUser = null;
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
  document.getElementById("userUsername").innerText = `@${currentUser.username} · ${currentUser.role === "master" ? "master" : "admin"}`;
  chip.classList.remove("hidden");
}

function updateMasterUi() {
  const isMaster = Boolean(currentUser?.isMaster);
  document.getElementById("panelUsersMenuLink").classList.toggle("hidden", !isMaster);

  if (!isMaster && currentPage === "panelUsers") {
    setPage("dashboard");
  }
}

function connectSocket() {
  if (socket) {
    return;
  }

  socket = io(API, { withCredentials: true });

  socket.on("new-log", async log => {
    addLog(log);

    if ([
      "KEY_REMOVED",
      "KEY_RETURNED",
      "LOCKER_DOOR_OPENED",
      "LOCKER_DOOR_CLOSED",
      "REMOTE_UNLOCK_REQUESTED",
      "REMOTE_RELEASE_ALL_REQUESTED"
    ].includes(log.event)) {
      await loadLockers();
    }

    if ([
      "RFID_USER_CREATED",
      "RFID_USER_UPDATED",
      "RFID_USER_DELETED"
    ].includes(log.event)) {
      await loadRfidUsers();
    }

    if ([
      "RFID_ITEM_CREATED",
      "RFID_ITEM_UPDATED",
      "RFID_ITEM_DELETED"
    ].includes(log.event)) {
      await loadRfidItems();
    }

    if ([
      "PANEL_USER_CREATED",
      "PANEL_USER_UPDATED",
      "PANEL_USER_DELETED"
    ].includes(log.event) && currentUser?.isMaster) {
      await loadPanelUsers();
    }
  });
  socket.on("rfid-tag-assignment-updated", assignment => {
    currentTagAssignment = assignment;
    renderRfidAssignmentStatus();

    if (assignment?.status === "completed" && assignment?.result?.success && assignment?.result?.tagId) {
      document.getElementById("rfidItemTagId").value = assignment.result.tagId;
      showToast(`Nadano tag ${assignment.result.tagId}.`);
    }

    if (assignment?.status === "failed") {
      showToast(assignment.result?.error || "Nie udało się nadać taga RFID.", true);
    }
  });
  socket.on("active-codes-changed", async () => {
    await loadActiveCodes();
  });
  socket.on("logs-cleared", () => {
    renderEmptyState("logs", "Brak logów do wyświetlenia.");
  });
  socket.on("connect", () => {
    renderSystemStatus();
    refreshSystemStatus();
  });
  socket.on("system-status", payload => {
    systemStatusData = payload;
    renderSystemStatus();
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
  const shouldOpen = forceOpen === null ? drawer.classList.contains("hidden") : forceOpen;
  drawer.classList.toggle("hidden", !shouldOpen);
}

function setPage(page, closeMenu = true) {
  if (page === "panelUsers" && !currentUser?.isMaster) {
    page = "dashboard";
  }

  currentPage = page;
  document.getElementById("dashboardPage").classList.toggle("active", page === "dashboard");
  document.getElementById("usersPage").classList.toggle("active", page === "users");
  document.getElementById("itemsPage").classList.toggle("active", page === "items");
  document.getElementById("panelUsersPage").classList.toggle("active", page === "panelUsers");
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
  metaTheme.setAttribute("content", resolvedTheme === "dark" ? "#07111f" : "#edf3ff");
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

function renderEmptyState(listId, message) {
  const list = document.getElementById(listId);
  list.innerHTML = "";
  const empty = document.createElement("li");
  empty.className = "muted-empty";
  empty.textContent = message;
  list.appendChild(empty);
}

function showToast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.innerText = msg;
  const isLight = document.documentElement.dataset.theme === "light";
  t.style.background = isError
    ? (isLight ? "rgba(255, 233, 236, 0.98)" : "rgba(88, 17, 22, 0.95)")
    : (isLight ? "rgba(255, 255, 255, 0.92)" : "rgba(6, 14, 25, 0.92)");
  t.style.color = isError
    ? (isLight ? "#7f1d2d" : "#ffe7e9")
    : (isLight ? "#142033" : "#f5f7fb");
  t.classList.add("show");

  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
  }

  toastTimeoutId = setTimeout(() => t.classList.remove("show"), 2500);
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

  const meta = document.getElementById("generatedCodeMeta");
  const expiresAt = formatDateTime(data.expiresAt);
  const delivery = data.emailDelivery;

  if (delivery?.attempted) {
    if (delivery.sent) {
      setGeneratedDeliveryStatus("E-mail wysłany", "success");
      meta.innerText = `Kod do skrytki S${data.locker} wygasa ${expiresAt}. Wysłano go na ${delivery.recipientEmail}.`;
      return;
    }

    setGeneratedDeliveryStatus("E-mail niewysłany", "warning");
    meta.innerText = `Kod do skrytki S${data.locker} wygasa ${expiresAt}. Nie udało się wysłać go na ${delivery.recipientEmail}. ${summarizeDeliveryError(delivery.error)}`;
    return;
  }

  setGeneratedDeliveryStatus();
  meta.innerText = `Kod do skrytki S${data.locker} wygasa ${expiresAt}.`;
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
    ? `📭 ${codeData.recipientEmail}`
    : `✉ ${codeData.recipientEmail}`;

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
  document.getElementById("rfidItemType").value = "brelok";
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
  document.getElementById("rfidItemId").value = item._id;
  document.getElementById("rfidItemName").value = item.name;
  document.getElementById("rfidItemTagId").value = item.tagId;
  document.getElementById("rfidItemType").value = item.itemType;
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

function renderRfidUsers() {
  const container = document.getElementById("rfidUsersList");
  container.innerHTML = "";

  if (rfidUsersData.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted-empty";
    empty.textContent = "Brak zarejestrowanych użytkowników RFID.";
    container.appendChild(empty);
    return;
  }

  rfidUsersData.forEach(user => {
    const card = document.createElement("div");
    card.className = "user-card";

    const header = document.createElement("div");
    header.className = "user-card-header";

    const meta = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "user-card-title";
    title.textContent = user.name;

    const tag = document.createElement("div");
    tag.className = "user-tag-chip";
    tag.textContent = `Tag RFID: ${user.tagId}`;

    meta.appendChild(title);
    meta.appendChild(tag);

    const actions = document.createElement("div");
    actions.className = "user-card-actions";

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
    header.appendChild(meta);
    header.appendChild(actions);

    const lockers = document.createElement("div");
    lockers.className = "user-lockers";
    user.allowedLockers.forEach(locker => {
      const chip = document.createElement("span");
      chip.className = "user-locker-chip";
      chip.textContent = `S${locker}`;
      lockers.appendChild(chip);
    });

    card.appendChild(header);
    card.appendChild(lockers);
    container.appendChild(card);
  });
}

function renderRfidItems() {
  const container = document.getElementById("rfidItemsList");
  container.innerHTML = "";

  if (rfidItemsData.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted-empty";
    empty.textContent = "Brak zdefiniowanych przedmiotów RFID.";
    container.appendChild(empty);
    return;
  }

  rfidItemsData.forEach(item => {
    const card = document.createElement("div");
    card.className = "user-card";

    const header = document.createElement("div");
    header.className = "user-card-header";

    const meta = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "user-card-title";
    title.textContent = item.name;

    const tag = document.createElement("div");
    tag.className = "user-tag-chip";
    tag.textContent = `UID: ${item.tagId}`;

    meta.appendChild(title);
    meta.appendChild(tag);

    const chips = document.createElement("div");
    chips.className = "user-lockers";

    const typeChip = document.createElement("span");
    typeChip.className = "user-locker-chip";
    typeChip.textContent = getItemTypeLabel(item.itemType);
    chips.appendChild(typeChip);

    const actions = document.createElement("div");
    actions.className = "user-card-actions";

    const editButton = document.createElement("button");
    editButton.className = "secondary-button";
    editButton.textContent = "Edytuj";
    editButton.addEventListener("click", () => populateRfidItemForm(item));

    const deleteButton = document.createElement("button");
    deleteButton.className = "danger";
    deleteButton.textContent = "Usuń";
    deleteButton.addEventListener("click", () => deleteRfidItem(item._id, item.name));

    actions.appendChild(editButton);
    actions.appendChild(deleteButton);
    header.appendChild(meta);
    header.appendChild(actions);

    card.appendChild(header);
    card.appendChild(chips);
    container.appendChild(card);
  });
}

function renderRfidAssignmentStatus() {
  const status = document.getElementById("rfidAssignmentStatus");
  const button = document.getElementById("assignRfidTagButton");
  const itemName = document.getElementById("rfidItemName").value.trim();
  const esp32Connected = Boolean(systemStatusData?.esp32?.connected);

  if (!esp32Connected) {
    status.textContent = "Nadawanie taga jest dostępne tylko wtedy, gdy panel ma aktywne połączenie z ESP32.";
    button.disabled = true;
    button.textContent = "ESP32 offline";
    return;
  }

  if (!currentTagAssignment || !["pending", "completed", "failed"].includes(currentTagAssignment.status)) {
    status.textContent = "Możesz wpisać ID ręcznie albo uruchomić nadawanie na master readerze.";
    button.disabled = false;
    button.textContent = "Nadaj tag";
    return;
  }

  if (currentTagAssignment.status === "pending") {
    const label = currentTagAssignment.itemName || itemName || "przedmiotu";
    status.textContent = `Tryb nadawania jest aktywny. Przyłóż tag do master readera, aby zapisać ID ${currentTagAssignment.tagId} dla ${label}.`;
    button.disabled = true;
    button.textContent = "Oczekiwanie...";
    return;
  }

  if (currentTagAssignment.status === "completed") {
    status.textContent = `Tag został nadany. Nowe ID: ${currentTagAssignment.result?.tagId || currentTagAssignment.tagId}.`;
    button.disabled = false;
    button.textContent = "Nadaj tag";
    return;
  }

  status.textContent = `Nadawanie nie powiodło się: ${currentTagAssignment.result?.error || "nieznany błąd"}.`;
  button.disabled = false;
  button.textContent = "Spróbuj ponownie";
}

function renderPanelUsers() {
  const container = document.getElementById("panelUsersList");
  container.innerHTML = "";

  if (!currentUser?.isMaster) {
    const empty = document.createElement("div");
    empty.className = "muted-empty";
    empty.textContent = "Ta sekcja jest dostępna tylko dla użytkownika master.";
    container.appendChild(empty);
    return;
  }

  if (panelUsersData.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted-empty";
    empty.textContent = "Brak kont panelu.";
    container.appendChild(empty);
    return;
  }

  panelUsersData.forEach(user => {
    const card = document.createElement("div");
    card.className = "user-card";

    const header = document.createElement("div");
    header.className = "user-card-header";

    const meta = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "user-card-title";
    title.textContent = user.displayName;

    const tag = document.createElement("div");
    tag.className = "user-tag-chip";
    tag.textContent = `@${user.username}`;

    meta.appendChild(title);
    meta.appendChild(tag);

    const chips = document.createElement("div");
    chips.className = "user-lockers";

    const roleChip = document.createElement("span");
    roleChip.className = "user-locker-chip";
    roleChip.textContent = user.role === "master" ? "Master" : "Administrator";
    chips.appendChild(roleChip);

    const actions = document.createElement("div");
    actions.className = "user-card-actions";

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
    header.appendChild(meta);
    header.appendChild(actions);

    card.appendChild(header);
    card.appendChild(chips);
    container.appendChild(card);
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

  const itemId = document.getElementById("rfidItemId").value;
  const payload = {
    name: document.getElementById("rfidItemName").value.trim(),
    tagId: document.getElementById("rfidItemTagId").value.trim(),
    itemType: document.getElementById("rfidItemType").value
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
  const itemName = document.getElementById("rfidItemName").value.trim();

  try {
    currentTagAssignment = await apiFetch("/rfid-items/tag-assignment/start", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ itemName })
    });

    renderRfidAssignmentStatus();
    showToast("Włączono tryb nadawania taga na master readerze.");
  } catch (error) {
    showToast(error.message, true);
  }
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
  const confirmed = window.confirm(`Czy na pewno chcesz usunąć użytkownika ${name}?`);

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

async function deleteRfidItem(itemId, name) {
  const confirmed = window.confirm(`Czy na pewno chcesz usunąć przedmiot ${name}?`);

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch(`/rfid-items/${itemId}`, {
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
  const confirmed = window.confirm(`Czy na pewno chcesz usunąć użytkownika panelu ${name}?`);

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
      showToast("Kod wygenerowany 🚀");
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
    const data = await apiFetch("/lockers");
    const container = document.getElementById("lockers");
    container.innerHTML = "";

    data.forEach(l => {
      const div = document.createElement("div");
      div.className = "locker " + (l.hasTag && l.isDoorClosed ? "ok" : "bad");

      const top = document.createElement("div");
      top.className = "locker-top";

      const title = document.createElement("h3");
      title.className = "locker-name";
      title.textContent = `Skrytka ${l.locker}`;

      const state = document.createElement("div");
      state.className = "locker-state";

      const tagBadge = document.createElement("span");
      tagBadge.className = `locker-badge ${l.hasTag ? "good" : "alert"}`;
      tagBadge.textContent = l.hasTag ? "RFID: klucz obecny" : "RFID: brak klucza";

      const doorBadge = document.createElement("span");
      doorBadge.className = `locker-badge ${l.isDoorClosed ? "good" : "warn"}`;
      doorBadge.textContent = l.isDoorClosed ? "Drzwiczki: domknięte" : "Drzwiczki: otwarte";

      state.appendChild(tagBadge);
      state.appendChild(doorBadge);
      top.appendChild(title);
      top.appendChild(state);

      const copy = document.createElement("div");
      copy.className = "locker-copy";
      const detectedItem = describeDetectedItem(l);
      copy.textContent = [
        l.hasTag && l.isDoorClosed
          ? "Skrytka jest gotowa operacyjnie. Klucz znajduje się na miejscu, a kontrakton potwierdza zamknięcie."
          : "Skrytka wymaga uwagi operatora. Sprawdź status RFID oraz domknięcie drzwiczek.",
        `${detectedItem.title}.`,
        detectedItem.meta
      ].join(" ");

      const actions = document.createElement("div");
      actions.className = "locker-actions";

      const openButton = document.createElement("button");
      openButton.textContent = `Otwórz S${l.locker}`;
      openButton.addEventListener("click", () => openLocker(l.locker));

      const refreshButton = document.createElement("button");
      refreshButton.className = "secondary-button";
      refreshButton.textContent = "Odśwież";
      refreshButton.addEventListener("click", loadLockers);

      actions.appendChild(openButton);
      actions.appendChild(refreshButton);
      div.appendChild(top);
      div.appendChild(copy);
      div.appendChild(actions);
      container.appendChild(div);
    });
  } catch (error) {
    showToast(error.message, true);
  }
}

async function openLocker(locker) {
  try {
    await apiFetch("/open-locker", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ locker })
    });

    showToast(`Wysłano polecenie otwarcia S${locker}`);
    await loadLockers();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function releaseAllLockers() {
  const confirmed = window.confirm("Czy na pewno chcesz zwolnić blokadę wszystkich skrytek?");

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch("/release-all-lockers", {
      method: "POST"
    });

    showToast("Wysłano polecenie zwolnienia wszystkich skrytek.");
    await loadLockers();
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
      return;
    }

    activeCodesData.forEach(c => {
      const li = document.createElement("li");
      li.id = "code-" + c.code;

      const row = document.createElement("div");
      row.className = "code-row";

      const meta = document.createElement("div");
      meta.className = "code-meta";

      const label = document.createElement("span");
      label.className = "code-chip";
      label.textContent = `${c.code} · S${c.locker}`;

      const deliveryChip = createEmailDeliveryChip(c);
      const timer = document.createElement("span");
      timer.className = "timer";

      const button = document.createElement("button");
      button.className = "danger";
      button.textContent = "Wyłącz";
      button.addEventListener("click", () => deactivate(c.code));

      meta.appendChild(label);
      if (deliveryChip) {
        meta.appendChild(deliveryChip);
      }
      meta.appendChild(timer);
      row.appendChild(meta);
      row.appendChild(button);
      li.appendChild(row);
      list.appendChild(li);
    });

    updateCountdowns();
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
      return;
    }

    const s = Math.floor(t / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    el.querySelector(".timer").innerText = `⏱ ${h}h ${m}m ${sec}s`;
  });
}

async function deactivate(code) {
  try {
    await apiFetch("/deactivate-code", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ code })
    });

    showToast("Kod dezaktywowany ❌");
    await loadActiveCodes();
  } catch (error) {
    showToast(error.message, true);
  }
}

function addLog(log) {
  const list = document.getElementById("logs");
  const emptyState = list.querySelector(".muted-empty");

  if (emptyState) {
    emptyState.remove();
  }

  const li = document.createElement("li");

  const time = new Date(log.timestamp).toLocaleString();
  const itemLabel = formatLogItemLabel(log);

  let text = "";
  let cls = "log-info";

  switch (log.event) {
    case "LOCKER_OPENED":
      text = `🔓 S${log.locker} kod ${log.code}`;
      cls = "log-success";
      break;
    case "INVALID_CODE":
      text = `❌ zły kod ${log.code}`;
      cls = "log-error";
      break;
    case "CODE_GENERATED":
      text = `➕ kod ${log.code}`;
      break;
    case "CODE_EMAIL_SENT":
      text = `✉️ wysłano kod ${log.code}`;
      cls = "log-success";
      break;
    case "CODE_EMAIL_FAILED":
      text = `📭 błąd wysyłki kodu ${log.code}`;
      cls = "log-error";
      break;
    case "CODE_DEACTIVATED":
      text = `🚫 kod ${log.code}`;
      cls = "log-warning";
      break;
    case "KEY_REMOVED":
      text = `🔑 wyjęty S${log.locker}${itemLabel}`;
      cls = "log-warning";
      break;
    case "KEY_RETURNED":
      text = `📥 zwrócony S${log.locker}${itemLabel}`;
      cls = "log-success";
      break;
    case "LOCKER_DOOR_OPENED":
      text = `🚪 otwarte drzwiczki S${log.locker}`;
      cls = "log-warning";
      break;
    case "LOCKER_DOOR_CLOSED":
      text = `✅ domknięte drzwiczki S${log.locker}`;
      cls = "log-success";
      break;
    case "REMOTE_UNLOCK_REQUESTED":
      text = `🛰️ zdalne otwarcie S${log.locker}`;
      break;
    case "REMOTE_RELEASE_ALL_REQUESTED":
      text = "⚠️ zwolniono blokade wszystkich skrytek";
      cls = "log-warning";
      break;
    case "RFID_ACCESS_GRANTED":
      text = `🪪 autoryzowany tag RFID${itemLabel}`;
      cls = "log-success";
      break;
    case "RFID_ACCESS_DENIED":
      text = `⛔ odrzucony tag RFID${itemLabel}`;
      cls = "log-error";
      break;
    case "RFID_USER_CREATED":
      text = "👤 dodano użytkownika RFID";
      break;
    case "RFID_USER_UPDATED":
      text = "🛠️ zaktualizowano użytkownika RFID";
      break;
    case "RFID_USER_DELETED":
      text = "🗑️ usunięto użytkownika RFID";
      cls = "log-warning";
      break;
    case "RFID_ITEM_CREATED":
      text = "🏷️ dodano przedmiot RFID";
      break;
    case "RFID_ITEM_UPDATED":
      text = "🛠️ zaktualizowano przedmiot RFID";
      break;
    case "RFID_ITEM_DELETED":
      text = "🗑️ usunięto przedmiot RFID";
      cls = "log-warning";
      break;
    case "PANEL_USER_CREATED":
      text = "🧑 dodano użytkownika panelu";
      break;
    case "PANEL_USER_UPDATED":
      text = "🛠️ zaktualizowano użytkownika panelu";
      break;
    case "PANEL_USER_DELETED":
      text = "🗑️ usunięto użytkownika panelu";
      cls = "log-warning";
      break;
  }

  li.className = cls;
  li.innerText = `${time} | ${text}`;
  list.prepend(li);
  list.scrollTop = 0;
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
    const logs = await apiFetch("/logs");

    if (logs.length === 0) {
      renderEmptyState("logs", "Brak logów do wyświetlenia.");
      return;
    }

    const list = document.getElementById("logs");
    list.innerHTML = "";
    logs.reverse().forEach(addLog);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function clearLogs() {
  const confirmed = window.confirm("Czy na pewno chcesz usunąć wszystkie logi?");

  if (!confirmed) {
    return;
  }

  try {
    await apiFetch("/logs/clear", {
      method: "POST"
    });

    renderEmptyState("logs", "Brak logów do wyświetlenia.");
    showToast("Logi zostały wyczyszczone.");
  } catch (error) {
    showToast(error.message, true);
  }
}

document.getElementById("themeToggle").addEventListener("click", cycleTheme);
document.getElementById("menuButton").addEventListener("click", () => toggleMenu());
document.getElementById("recipientEmail").addEventListener("input", updateGenerateButtonLabel);
document.querySelectorAll(".menu-link").forEach(link => {
  link.addEventListener("click", () => setPage(link.dataset.page));
});
document.getElementById("logoutButton").addEventListener("click", logout);
document.getElementById("rfidUserForm").addEventListener("submit", submitRfidUserForm);
document.getElementById("rfidUserReset").addEventListener("click", resetRfidUserForm);
document.getElementById("rfidItemForm").addEventListener("submit", submitRfidItemForm);
document.getElementById("rfidItemReset").addEventListener("click", resetRfidItemForm);
document.getElementById("assignRfidTagButton").addEventListener("click", startRfidTagAssignment);
document.getElementById("rfidItemName").addEventListener("input", renderRfidAssignmentStatus);
document.getElementById("panelUserForm").addEventListener("submit", submitPanelUserForm);
document.getElementById("panelUserReset").addEventListener("click", resetPanelUserForm);
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

  if (drawer.classList.contains("hidden")) {
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
updateGenerateButtonLabel();
applyTheme(getStoredTheme());
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
}, 5000);
setInterval(() => {
  if (isAuthenticated) {
    refreshSystemStatus();
  }
}, 15000);
