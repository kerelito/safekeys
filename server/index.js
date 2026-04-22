require("dotenv").config();

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const session = require("express-session");
const { Server } = require("socket.io");

const { createDiscordBot } = require("./bot/discordBot");
const { lockerService } = require("./services/lockerService");

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
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

if (!MONGODB_URI) {
  throw new Error("Brakuje zmiennej środowiskowej MONGODB_URI.");
}

if (!SESSION_SECRET) {
  throw new Error("Brakuje zmiennej środowiskowej SESSION_SECRET.");
}

const PANEL_USERS = [1, 2, 3].map(index => ({
  username: process.env[`ADMIN_${index}_USERNAME`],
  password: process.env[`ADMIN_${index}_PASSWORD`],
  displayName: process.env[`ADMIN_${index}_DISPLAY_NAME`]
})).filter(user => user.username && user.password && user.displayName);

if (PANEL_USERS.length !== 3) {
  throw new Error("Brakuje pełnej konfiguracji trzech użytkowników panelu w zmiennych ADMIN_1_*, ADMIN_2_* i ADMIN_3_*.");
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

mongoose.connect(MONGODB_URI)
  .then(() => console.log("Połączono z MongoDB ✅"))
  .catch(err => console.error("Błąd MongoDB ❌", err));

lockerService.on("log", log => {
  io.emit("new-log", log);
});

lockerService.on("logs-cleared", () => {
  io.emit("logs-cleared");
});

lockerService.on("remote-action-queued", action => {
  io.emit("remote-action-queued", action);
});

app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/auth/session", (req, res) => {
  res.json({
    authenticated: Boolean(req.session?.isAuthenticated),
    username: req.session?.username || null,
    displayName: req.session?.displayName || null
  });
});

app.post("/auth/login", (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (!username || !password) {
    return res.status(400).json({ error: "Podaj login i hasło." });
  }

  const matchedUser = PANEL_USERS.find(user => user.username === username && user.password === password);

  if (!matchedUser) {
    return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
  }

  req.session.isAuthenticated = true;
  req.session.username = matchedUser.username;
  req.session.displayName = matchedUser.displayName;

  return res.json({
    success: true,
    username: matchedUser.username,
    displayName: matchedUser.displayName
  });
});

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
  "/users",
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
  const locker = Number(req.body.locker);
  const hours = Number(req.body.hours);

  const result = await lockerService.generateCode(locker, hours, {
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

app.post("/locker-status", requireDeviceKey, asyncHandler(async (req, res) => {
  const locker = Number(req.body.locker);
  const { hasTag } = req.body;

  const result = await lockerService.updateLockerStatus(locker, hasTag, {
    source: "rfid"
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

app.get("/device/actions", requireDeviceKey, asyncHandler(async (req, res) => {
  const actions = await lockerService.consumeRemoteActions();
  res.json({ actions });
}));

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

server.listen(PORT, HOST, () => {
  console.log(`Server działa na ${HOST}:${PORT}`);
});

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
