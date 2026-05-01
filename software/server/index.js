require("dotenv").config();

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const session = require("express-session");
const { Server } = require("socket.io");

const { createDiscordBot } = require("./bot/discordBot");
const { createEmailService } = require("./services/emailService");
const { lockerService } = require("./services/lockerService");
const { panelUserService } = require("./services/panelUserService");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DEVICE_API_KEY = process.env.DEVICE_API_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const DISCORD_NOTIFICATIONS_CHANNEL_ID = process.env.DISCORD_NOTIFICATIONS_CHANNEL_ID;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_SECURE = process.env.SMTP_SECURE;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL;
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME;
const SMTP_REPLY_TO = process.env.SMTP_REPLY_TO;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DEVICE_HEARTBEAT_TIMEOUT_MS = 180 * 1000;
const DEVICE_STATUS_BROADCAST_INTERVAL_MS = 30000;

if (!MONGODB_URI) {
  throw new Error("Brakuje zmiennej środowiskowej MONGODB_URI.");
}

if (!SESSION_SECRET) {
  throw new Error("Brakuje zmiennej środowiskowej SESSION_SECRET.");
}

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    maxAge: 1000 * 60 * 60 * 12
  }
});

app.use(sessionMiddleware);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);

io.use(wrap(sessionMiddleware));
io.use((socket, next) => {
  if (socket.request.session?.isAuthenticated) {
    return next();
  }

  return next(new Error("unauthorized"));
});

function requireAuth(req, res, next) {
  if (req.session?.isAuthenticated) {
    return next();
  }

  return res.status(401).json({ error: "Wymagane logowanie." });
}

function requireMaster(req, res, next) {
  if (req.session?.role === "master") {
    return next();
  }

  return res.status(403).json({ error: "Ta sekcja jest dostępna tylko dla użytkownika master." });
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireDeviceKey(req, res, next) {
  if (!DEVICE_API_KEY) {
    return next();
  }

  const providedKey = req.get("x-device-key");

  if (providedKey === DEVICE_API_KEY) {
    return next();
  }

  return res.status(401).json({ error: "Brak autoryzacji urządzenia." });
}

function getSessionActor(req, fallback = "panel") {
  return req.session?.displayName || req.session?.username || fallback;
}

function getRequestKey(req) {
  return req.ip || req.get("x-forwarded-for") || req.socket?.remoteAddress || "unknown";
}

function createRateLimit({ windowMs, max, message }) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.method}:${req.path}:${getRequestKey(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ error: message || "Za dużo prób. Spróbuj ponownie za chwilę." });
    }

    return next();
  };
}

const MONGOOSE_STATES = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting"
};

const deviceStatus = {
  lastSeenAt: null,
  pingMs: null,
  wifiRssi: null,
  ip: null,
  firmware: null,
  uptimeMs: null,
  freeHeap: null
};
let lastDeviceStatusBroadcastMs = 0;

function getDatabaseStatus() {
  const readyState = mongoose.connection.readyState;
  return {
    connected: readyState === 1,
    state: MONGOOSE_STATES[readyState] || "unknown"
  };
}

function getEsp32Status() {
  const lastSeenAt = deviceStatus.lastSeenAt ? new Date(deviceStatus.lastSeenAt) : null;
  const connected = Boolean(lastSeenAt) && (Date.now() - lastSeenAt.getTime()) <= DEVICE_HEARTBEAT_TIMEOUT_MS;

  return {
    connected,
    lastSeenAt: deviceStatus.lastSeenAt,
    pingMs: deviceStatus.pingMs,
    wifiRssi: deviceStatus.wifiRssi,
    ip: deviceStatus.ip,
    firmware: deviceStatus.firmware,
    uptimeMs: deviceStatus.uptimeMs,
    freeHeap: deviceStatus.freeHeap
  };
}

function buildSystemStatus() {
  return {
    serverTime: new Date().toISOString(),
    database: getDatabaseStatus(),
    esp32: getEsp32Status()
  };
}

async function buildOperationalAlerts() {
  const [lockers, activeCodes, invalidLogs] = await Promise.all([
    lockerService.getLockers(),
    lockerService.getActiveCodes(),
    lockerService.getLogs({
      event: "INVALID_CODE",
      from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      limit: 8
    })
  ]);
  const status = buildSystemStatus();
  const alerts = [];

  if (!status.database.connected) {
    alerts.push({
      id: "database-offline",
      severity: "critical",
      title: "Baza danych offline",
      detail: `MongoDB zgłasza stan: ${status.database.state}.`,
      action: "Sprawdź połączenie i konfigurację MONGODB_URI."
    });
  }

  if (!status.esp32.connected) {
    alerts.push({
      id: "esp32-offline",
      severity: "warning",
      title: "ESP32 bez świeżego heartbeat",
      detail: status.esp32.lastSeenAt
        ? `Ostatni kontakt: ${status.esp32.lastSeenAt}.`
        : "Urządzenie nie wysłało jeszcze heartbeat.",
      action: "Sprawdź zasilanie, WiFi i klucz DEVICE_API_KEY."
    });
  }

  lockers
    .filter(locker => !locker.hasTag || !locker.isDoorClosed)
    .forEach(locker => {
      alerts.push({
        id: `locker-${locker.locker}`,
        severity: locker.hasTag ? "warning" : "critical",
        title: `Skrytka ${locker.locker} wymaga uwagi`,
        detail: [
          locker.hasTag ? "Klucz wykryty" : "Brak klucza RFID",
          locker.isDoorClosed ? "drzwiczki zamknięte" : "drzwiczki otwarte"
        ].join(", "),
        action: "Zweryfikuj fizyczny stan skrytki."
      });
    });

  if (activeCodes.length >= 5) {
    alerts.push({
      id: "many-active-codes",
      severity: "info",
      title: "Dużo aktywnych kodów",
      detail: `Aktualnie aktywnych kodów: ${activeCodes.length}.`,
      action: "Rozważ dezaktywację nieużywanych dostępów."
    });
  }

  if (invalidLogs.length >= 5) {
    alerts.push({
      id: "invalid-code-spike",
      severity: "warning",
      title: "Wiele błędnych kodów",
      detail: `Ostatnio odnotowano ${invalidLogs.length} prób z błędnym kodem.`,
      action: "Sprawdź logi i upewnij się, że kody nie są przepisywane ręcznie z błędami."
    });
  }

  return alerts;
}

const loginRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: "Za dużo prób logowania. Spróbuj ponownie za kilka minut."
});

const mutationRateLimit = createRateLimit({
  windowMs: 60 * 1000,
  max: 80,
  message: "Za dużo operacji w krótkim czasie. Odczekaj chwilę."
});

const emailService = createEmailService({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  user: SMTP_USER,
  pass: SMTP_PASS,
  apiKey: BREVO_API_KEY,
  fromEmail: SMTP_FROM_EMAIL,
  fromName: SMTP_FROM_NAME,
  replyTo: SMTP_REPLY_TO
});

lockerService.setEmailService(emailService);

if (emailService.isEnabled()) {
  emailService.verifyConnection()
    .then(() => console.log("Wysylka e-mail aktywna ✅"))
    .catch(error => console.error("Nie udalo sie zweryfikowac wysylki e-mail ❌", {
      errorMessage: error.message,
      errorCode: error.code || null,
      errorCommand: error.command || null,
      emailProvider: error.emailProvider || null,
      apiEndpoint: error.apiEndpoint || null,
      smtpHost: error.smtpHost || null,
      smtpPort: error.smtpPort || null,
      smtpSecure: error.smtpSecure ?? null
    }));
} else {
  console.log("Wysylka e-mail pominieta: brak konfiguracji.");
}

lockerService.on("log", log => {
  io.emit("new-log", log);
});

lockerService.on("logs-cleared", () => {
  io.emit("logs-cleared");
});

lockerService.on("remote-action-queued", action => {
  io.emit("remote-action-queued", action);
});

lockerService.on("remote-action-updated", action => {
  io.emit("remote-action-updated", action);
});

lockerService.on("active-codes-changed", () => {
  io.emit("active-codes-changed");
});

lockerService.on("rfid-tag-assignment-updated", assignment => {
  io.emit("rfid-tag-assignment-updated", assignment);
});

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/auth/session", (req, res) => {
  res.json({
    authenticated: Boolean(req.session?.isAuthenticated),
    username: req.session?.username || null,
    displayName: req.session?.displayName || null,
    role: req.session?.role || null,
    isMaster: req.session?.role === "master"
  });
});

app.post("/auth/login", loginRateLimit, asyncHandler(async (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (!username || !password) {
    return res.status(400).json({ error: "Podaj login i hasło." });
  }

  const matchedUser = await panelUserService.authenticate(username, password);

  req.session.isAuthenticated = true;
  req.session.username = matchedUser.username;
  req.session.displayName = matchedUser.displayName;
  req.session.role = matchedUser.role;
  req.session.userId = matchedUser._id;

  await lockerService.createLog({
    event: "AUTH_LOGIN",
    source: "web",
    actor: matchedUser.displayName || matchedUser.username
  });

  return res.json({
    success: true,
    username: matchedUser.username,
    displayName: matchedUser.displayName,
    role: matchedUser.role,
    isMaster: matchedUser.role === "master"
  });
}));

app.post("/auth/logout", asyncHandler(async (req, res) => {
  if (req.session?.isAuthenticated) {
    await lockerService.createLog({
      event: "AUTH_LOGOUT",
      source: "web",
      actor: getSessionActor(req)
    });
  }

  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
}));

app.use([
  "/generate-code",
  "/deactivate-code",
  "/open-locker",
  "/release-all-lockers",
  "/lockers",
  "/system-status",
  "/users",
  "/rfid-items",
  "/rfid-items/tag-assignment",
  "/panel-users",
  "/active-codes",
  "/logs",
  "/logs/clear",
  "/alerts",
  "/export/backup",
  "/device/actions/history"
], requireAuth);

app.use([
  "/generate-code",
  "/deactivate-code",
  "/open-locker",
  "/release-all-lockers",
  "/users",
  "/rfid-items",
  "/panel-users",
  "/logs/clear"
], mutationRateLimit);

app.post("/verify-code", requireDeviceKey, asyncHandler(async (req, res) => {
  const { code } = req.body;
  const result = await lockerService.verifyCode(code, { source: "device" });
  res.json(result);
}));

app.post("/verify-tag", requireDeviceKey, asyncHandler(async (req, res) => {
  const { tagId } = req.body;
  const result = await lockerService.verifyRfidTag(tagId, { source: "rfid-user" });
  res.json(result);
}));

app.post("/generate-code", asyncHandler(async (req, res) => {
  const result = await lockerService.generateCode({
    locker: Number(req.body.locker),
    hours: Number(req.body.hours),
    recipientEmail: req.body.recipientEmail
  }, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.post("/deactivate-code", asyncHandler(async (req, res) => {
  const { code } = req.body;

  const result = await lockerService.deactivateCode(code, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.post("/open-locker", asyncHandler(async (req, res) => {
  const locker = Number(req.body.locker);

  const result = await lockerService.openLocker(locker, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.post("/release-all-lockers", asyncHandler(async (req, res) => {
  const result = await lockerService.releaseAllLockers({
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.get("/lockers", asyncHandler(async (req, res) => {
  const result = await lockerService.getLockers();
  res.json(result);
}));

app.get("/users", asyncHandler(async (req, res) => {
  const users = await lockerService.getRfidUsers();
  res.json(users);
}));

app.get("/rfid-items", asyncHandler(async (req, res) => {
  const items = await lockerService.getRfidItems();
  res.json(items);
}));

app.get("/rfid-items/tag-assignment", asyncHandler(async (req, res) => {
  res.json({ assignment: lockerService.getCurrentTagAssignment() });
}));

app.post("/users", asyncHandler(async (req, res) => {
  const result = await lockerService.createRfidUser({
    name: req.body.name,
    tagId: req.body.tagId,
    allowedLockers: req.body.allowedLockers
  }, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.status(201).json(result);
}));

app.post("/rfid-items", asyncHandler(async (req, res) => {
  const result = await lockerService.createRfidItem({
    name: req.body.name,
    tagId: req.body.tagId,
    itemType: req.body.itemType
  }, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.status(201).json(result);
}));

app.post("/rfid-items/tag-assignment/start", asyncHandler(async (req, res) => {
  const esp32Status = getEsp32Status();
  if (!esp32Status.connected) {
    return res.status(409).json({ error: "Nadawanie taga jest dostępne tylko przy aktywnym połączeniu z ESP32." });
  }

  const result = await lockerService.startTagAssignment({
    itemName: req.body.itemName
  }, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.status(201).json(result);
}));

app.put("/users/:userId", asyncHandler(async (req, res) => {
  const result = await lockerService.updateRfidUser(req.params.userId, {
    name: req.body.name,
    tagId: req.body.tagId,
    allowedLockers: req.body.allowedLockers
  }, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.delete("/users/:userId", asyncHandler(async (req, res) => {
  const result = await lockerService.deleteRfidUser(req.params.userId, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.put("/rfid-items/:itemId", asyncHandler(async (req, res) => {
  const result = await lockerService.updateRfidItem(req.params.itemId, {
    name: req.body.name,
    tagId: req.body.tagId,
    itemType: req.body.itemType
  }, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.delete("/rfid-items/:itemId", asyncHandler(async (req, res) => {
  const result = await lockerService.deleteRfidItem(req.params.itemId, {
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.get("/panel-users", requireMaster, asyncHandler(async (req, res) => {
  const users = await panelUserService.getPanelUsers();
  res.json(users);
}));

app.post("/panel-users", requireMaster, asyncHandler(async (req, res) => {
  const result = await panelUserService.createPanelUser({
    username: req.body.username,
    displayName: req.body.displayName,
    password: req.body.password,
    role: req.body.role
  });

  await lockerService.createLog({
    event: "PANEL_USER_CREATED",
    source: "web",
    actor: `${getSessionActor(req)} • ${result.displayName} • @${result.username}`
  });

  res.status(201).json(result);
}));

app.put("/panel-users/:userId", requireMaster, asyncHandler(async (req, res) => {
  const result = await panelUserService.updatePanelUser(req.params.userId, {
    username: req.body.username,
    displayName: req.body.displayName,
    password: req.body.password,
    role: req.body.role
  }, {
    currentUserId: req.session?.userId || null
  });

  await lockerService.createLog({
    event: "PANEL_USER_UPDATED",
    source: "web",
    actor: `${getSessionActor(req)} • ${result.displayName} • @${result.username}`
  });

  res.json(result);
}));

app.delete("/panel-users/:userId", requireMaster, asyncHandler(async (req, res) => {
  const removedUser = await panelUserService.deletePanelUser(req.params.userId, {
    currentUserId: req.session?.userId || null
  });

  await lockerService.createLog({
    event: "PANEL_USER_DELETED",
    source: "web",
    actor: `${getSessionActor(req)} • ${removedUser.displayName} • @${removedUser.username}`
  });

  res.json({ success: true });
}));

app.post("/locker-status", requireDeviceKey, asyncHandler(async (req, res) => {
  const locker = Number(req.body.locker);
  const { hasTag } = req.body;

  const result = await lockerService.updateLockerStatus(locker, hasTag, {
    source: "rfid",
    tagId: req.body.tagId
  });

  res.json(result);
}));

app.post("/locker-door-status", requireDeviceKey, asyncHandler(async (req, res) => {
  const locker = Number(req.body.locker);
  const { isDoorClosed } = req.body;

  const result = await lockerService.updateLockerDoorStatus(locker, isDoorClosed, {
    source: "contactron"
  });

  res.json(result);
}));

app.post("/device/heartbeat", requireDeviceKey, (req, res) => {
  const wasConnected = getEsp32Status().connected;
  deviceStatus.lastSeenAt = new Date().toISOString();
  deviceStatus.pingMs = typeof req.body.pingMs === "number" ? req.body.pingMs : null;
  deviceStatus.wifiRssi = typeof req.body.wifiRssi === "number" ? req.body.wifiRssi : null;
  deviceStatus.ip = typeof req.body.ip === "string" ? req.body.ip : null;
  deviceStatus.firmware = typeof req.body.firmware === "string" ? req.body.firmware : null;
  deviceStatus.uptimeMs = typeof req.body.uptimeMs === "number" ? req.body.uptimeMs : null;
  deviceStatus.freeHeap = typeof req.body.freeHeap === "number" ? req.body.freeHeap : null;

  const now = Date.now();
  if (!wasConnected || now - lastDeviceStatusBroadcastMs >= DEVICE_STATUS_BROADCAST_INTERVAL_MS) {
    io.emit("system-status", buildSystemStatus());
    lastDeviceStatusBroadcastMs = now;
  }

  res.json({ ok: true, serverTime: new Date().toISOString() });
});

app.post("/device/tag-assignment-result", requireDeviceKey, asyncHandler(async (req, res) => {
  const result = await lockerService.completeTagAssignment({
    assignmentId: req.body.assignmentId,
    success: req.body.success,
    tagId: req.body.tagId,
    physicalUid: req.body.physicalUid,
    error: req.body.error
  }, {
    source: "device",
    actor: req.body.physicalUid || "device"
  });

  res.json(result);
}));

app.post("/device/actions/ack", requireDeviceKey, (req, res) => {
  const result = lockerService.acknowledgeRemoteAction(req.body.actionId, {
    success: req.body.success,
    message: req.body.message
  }, {
    source: "device"
  });

  res.json(result);
});

app.get("/device/actions", requireDeviceKey, asyncHandler(async (req, res) => {
  const requestedWaitMs = Number(req.query.waitMs);
  const waitMs = Number.isFinite(requestedWaitMs)
    ? Math.max(0, Math.min(25000, Math.trunc(requestedWaitMs)))
    : 0;
  const actions = waitMs > 0
    ? await lockerService.waitForRemoteActions(waitMs)
    : await lockerService.consumeRemoteActions();
  res.json({ actions });
}));

app.get("/device/actions/history", (req, res) => {
  res.json(lockerService.getRemoteActionHistory());
});

app.get("/system-status", (req, res) => {
  res.json(buildSystemStatus());
});

app.get("/alerts", asyncHandler(async (req, res) => {
  const alerts = await buildOperationalAlerts();
  res.json(alerts);
}));

app.get("/active-codes", asyncHandler(async (req, res) => {
  const codes = await lockerService.getActiveCodes();
  res.json(codes);
}));

app.get("/logs/events", asyncHandler(async (req, res) => {
  const events = await lockerService.getLogEventTypes();
  res.json(events.sort());
}));

app.get("/logs/export", asyncHandler(async (req, res) => {
  const csv = await lockerService.exportLogs(req.query);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="safekeys-logi-${stamp}.csv"`);
  res.send(csv);
}));

app.get("/logs", asyncHandler(async (req, res) => {
  const logs = await lockerService.getLogs(req.query);
  res.json(logs);
}));

app.post("/logs/clear", asyncHandler(async (req, res) => {
  const result = await lockerService.clearLogs({
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
}));

app.get("/export/backup", requireMaster, asyncHandler(async (req, res) => {
  const [snapshot, panelUsers] = await Promise.all([
    lockerService.getBackupSnapshot(),
    panelUserService.getPanelUsers()
  ]);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="safekeys-backup-${stamp}.json"`);
  res.json({
    ...snapshot,
    panelUsers
  });
}));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  const message = status >= 500 ? "Wewnętrzny błąd serwera." : err.message;

  if (status >= 500) {
    console.error(err);
  }

  res.status(status).json({ error: message });
});

async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Połączono z MongoDB ✅");
    await panelUserService.ensureSeededFromEnv();

    server.listen(PORT, HOST, () => {
      console.log(`Server działa na ${HOST}:${PORT}`);
    });
  } catch (error) {
    console.error("Błąd startu serwera ❌", error);
    process.exit(1);
  }
}

startServer();

if (DISCORD_BOT_TOKEN && DISCORD_CLIENT_ID) {
  createDiscordBot({
    token: DISCORD_BOT_TOKEN,
    clientId: DISCORD_CLIENT_ID,
    guildId: DISCORD_GUILD_ID,
    notificationsChannelId: DISCORD_NOTIFICATIONS_CHANNEL_ID
  }, lockerService).catch(error => {
    console.error("Nie udało się uruchomić integracji Discord.", error);
  });
} else {
  console.log("Integracja Discord pominięta: brak DISCORD_BOT_TOKEN lub DISCORD_CLIENT_ID.");
}
