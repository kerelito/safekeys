const crypto = require("node:crypto");
const WebSocket = require("ws");

const deviceId = process.env.DEVICE_ID || "esp32-main";
const url = process.env.DEVICE_WS_URL || `wss://www.safekeys.pl:443/device/ws?deviceId=${encodeURIComponent(deviceId)}`;
const holdMs = Number(process.env.WS_HOLD_MS) || 60_000;
const connectTimeoutMs = Number(process.env.WS_CONNECT_TIMEOUT_MS) || 15_000;
const apiKey = process.env.DEVICE_API_KEY || "";
const bootId = crypto.randomBytes(8).toString("hex");

const headers = {};
if (apiKey) {
  headers["x-device-key"] = apiKey;
}

const ws = new WebSocket(url, {
  headers,
  perMessageDeflate: false
});

let openedAt = 0;
let completed = false;
let helloSent = false;
let holdTimer = null;

function finish(ok, message) {
  if (completed) {
    return;
  }

  completed = true;
  if (holdTimer) {
    clearTimeout(holdTimer);
  }
  clearTimeout(connectTimer);
  if (message) {
    console[ok ? "log" : "error"](message);
  }
  process.exitCode = ok ? 0 : 1;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(ok ? 1000 : 1011, ok ? "diagnostic_complete" : "diagnostic_failed");
  } else {
    process.exit();
  }
}

const connectTimer = setTimeout(() => {
  finish(false, `[device-ws] connection timeout after ${connectTimeoutMs}ms`);
}, connectTimeoutMs);

ws.on("upgrade", response => {
  console.log("[device-ws] upgrade", {
    statusCode: response.statusCode,
    secWebSocketExtensions: response.headers["sec-websocket-extensions"] || null,
    secWebSocketProtocol: response.headers["sec-websocket-protocol"] || null,
    server: response.headers.server || null
  });
});

ws.on("open", () => {
  openedAt = Date.now();
  clearTimeout(connectTimer);
  console.log("[device-ws] open", { url, holdMs, hasDeviceKey: Boolean(apiKey) });

  holdTimer = setTimeout(() => {
    if (!completed) {
      finish(true, `[device-ws] connection stayed open for ${Date.now() - openedAt}ms`);
    }
  }, holdMs);
});

ws.on("message", (data, isBinary) => {
  const bytes = Buffer.byteLength(data);
  console.log("[device-ws] message", { type: isBinary ? "binary" : "text", bytes });

  if (isBinary) {
    return;
  }

  let message;
  try {
    message = JSON.parse(data.toString("utf8"));
  } catch (error) {
    console.error("[device-ws] invalid JSON from server", error.message);
    return;
  }

  if (message.type === "server.hello" && !helloSent) {
    helloSent = true;
    ws.send(JSON.stringify({
      type: "device.hello",
      deviceId,
      messageId: `diag-${bootId}-1`,
      seq: 1,
      bootId,
      protocolVersion: 2,
      firmware: "node-device-ws-diagnostic"
    }));
    console.log("[device-ws] device.hello sent", { connectionId: message.connectionId || null });
  }
});

ws.on("ping", () => {
  console.log("[device-ws] ping");
});

ws.on("pong", () => {
  console.log("[device-ws] pong");
});

ws.on("close", (code, reason) => {
  const ageMs = openedAt ? Date.now() - openedAt : 0;
  console.log("[device-ws] close", {
    code,
    reason: reason.toString("utf8"),
    ageMs
  });

  if (!completed && ageMs < holdMs) {
    finish(false, `[device-ws] closed before ${holdMs}ms`);
  }
});

ws.on("error", error => {
  if (!completed) {
    finish(false, `[device-ws] error: ${error.message}`);
  }
});
