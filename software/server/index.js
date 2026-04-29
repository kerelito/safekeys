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
const DEVICE_HEARTBEAT_TIMEOUT_MS = 45 * 1000;

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

lockerService.on("active-codes-changed", () => {
  io.emit("active-codes-changed");
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

app.post("/auth/login", asyncHandler(async (req, res) => {
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

  return res.json({
    success: true,
    username: matchedUser.username,
    displayName: matchedUser.displayName,
    role: matchedUser.role,
    isMaster: matchedUser.role === "master"
  });
}));

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.use([
  "/generate-code",
  "/deactivate-code",
  "/open-locker",
  "/release-all-lockers",
  "/lockers",
  "/system-status",
  "/users",
  "/rfid-items",
  "/panel-users",
  "/active-codes",
  "/logs",
  "/logs/clear"
], requireAuth);

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
  deviceStatus.lastSeenAt = new Date().toISOString();
  deviceStatus.pingMs = typeof req.body.pingMs === "number" ? req.body.pingMs : null;
  deviceStatus.wifiRssi = typeof req.body.wifiRssi === "number" ? req.body.wifiRssi : null;
  deviceStatus.ip = typeof req.body.ip === "string" ? req.body.ip : null;
  deviceStatus.firmware = typeof req.body.firmware === "string" ? req.body.firmware : null;
  deviceStatus.uptimeMs = typeof req.body.uptimeMs === "number" ? req.body.uptimeMs : null;
  deviceStatus.freeHeap = typeof req.body.freeHeap === "number" ? req.body.freeHeap : null;

  io.emit("system-status", buildSystemStatus());
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

app.get("/device/actions", requireDeviceKey, asyncHandler(async (req, res) => {
  const actions = await lockerService.consumeRemoteActions();
  res.json({ actions });
}));

app.get("/system-status", (req, res) => {
  res.json(buildSystemStatus());
});

app.get("/active-codes", asyncHandler(async (req, res) => {
  const codes = await lockerService.getActiveCodes();
  res.json(codes);
}));

app.get("/logs", asyncHandler(async (req, res) => {
  const logs = await lockerService.getLogs();
  res.json(logs);
}));

app.post("/logs/clear", asyncHandler(async (req, res) => {
  const result = await lockerService.clearLogs({
    source: "web",
    actor: getSessionActor(req)
  });

  res.json(result);
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
