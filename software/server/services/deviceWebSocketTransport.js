const crypto = require("crypto");
const { WebSocket, WebSocketServer } = require("ws");
const {
  buildAck,
  buildLockerStatusResult,
  buildTagVerifyResult,
  DEFAULT_DEVICE_ID,
  DEVICE_PROTOCOL_VERSION,
  normalizeDeviceId
} = require("./deviceProtocol");

const DEVICE_WS_PATH = process.env.DEVICE_WS_PATH || "/device/ws";
const DEVICE_WS_PING_INTERVAL_MS = Number(process.env.DEVICE_WS_PING_INTERVAL_MS) || 30 * 1000;

function parseRequestUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function isDeviceRequestAuthorized(req, deviceApiKey) {
  if (!deviceApiKey) {
    return true;
  }

  const providedKey = req.headers["x-device-key"];
  return providedKey === deviceApiKey;
}

function attachDeviceWebSocketTransport(server, lockerService, options = {}) {
  const deviceApiKey = options.deviceApiKey || "";
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map();

  async function sendJson(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(JSON.stringify(payload));
  }

  async function sendPendingCommands(ws, { forceRedelivery = false } = {}) {
    if (!ws.deviceId || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const commands = await lockerService.deliverPendingRemoteActions({
      transport: "websocket",
      deviceId: ws.deviceId,
      forceRedelivery
    });

    if (commands.length === 0) {
      return;
    }

    await sendJson(ws, {
      type: "commands",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      serverTime: new Date().toISOString(),
      commands
    });
  }

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = parseRequestUrl(req);
    } catch (error) {
      return;
    }

    if (url.pathname !== DEVICE_WS_PATH) {
      return;
    }

    if (!isDeviceRequestAuthorized(req, deviceApiKey)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req, url);
    });
  });

  wss.on("connection", async (ws, req, url) => {
    ws.isAlive = true;
    ws.connectionId = crypto.randomUUID();
    ws.deviceId = normalizeDeviceId(url.searchParams.get("deviceId") || DEFAULT_DEVICE_ID);
    clients.set(ws.connectionId, ws);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async rawMessage => {
      let envelope;
      try {
        envelope = JSON.parse(rawMessage.toString("utf8"));
      } catch (error) {
        await sendJson(ws, {
          type: "ack",
          ok: false,
          error: "invalid_json",
          serverTime: new Date().toISOString()
        });
        return;
      }

      const context = {
        transport: "websocket",
        deviceId: ws.deviceId,
        connectionId: ws.connectionId,
        remoteAddress: req.socket?.remoteAddress || null
      };

      if (envelope.type === "state.batch") {
        await sendJson(ws, buildAck(envelope, {
          state: {
            queued: true
          }
        }));

        lockerService.processDeviceEnvelope(envelope, context)
          .then(async response => {
            if (response?.ok === false) {
              console.error("Asynchroniczne state.batch urzadzenia zostalo odrzucone.", {
                deviceId: ws.deviceId,
                connectionId: ws.connectionId,
                messageId: envelope.messageId || null,
                error: response.error || "unknown"
              });
              return;
            }

            await sendJson(ws, buildLockerStatusResult(envelope, response?.state || {}));
          })
          .catch(error => {
            console.error("Nie udalo sie asynchronicznie zapisac state.batch urzadzenia.", {
              deviceId: ws.deviceId,
              connectionId: ws.connectionId,
              messageId: envelope.messageId || null,
              error: error.message
            });
          });

        await sendPendingCommands(ws);
        return;
      }

      if (envelope.type === "tag.verify") {
        await sendJson(ws, buildAck(envelope));

        lockerService.processDeviceEnvelope(envelope, context)
          .then(async response => {
            const result = buildTagVerifyResult(envelope, response?.tagVerification || {}, {
              ok: response?.ok !== false,
              error: response?.ok === false ? response?.error : null
            });
            await sendJson(ws, result);
            try {
              await sendPendingCommands(ws);
            } catch (error) {
              console.error("Nie udalo sie wyslac polecen po weryfikacji RFID.", {
                deviceId: ws.deviceId,
                connectionId: ws.connectionId,
                messageId: envelope.messageId || null,
                error: error.message
              });
            }
          })
          .catch(async error => {
            console.error("Nie udalo sie zweryfikowac taga RFID przez WebSocket.", {
              deviceId: ws.deviceId,
              connectionId: ws.connectionId,
              messageId: envelope.messageId || null,
              error: error.message
            });
            await sendJson(ws, buildTagVerifyResult(envelope, {}, {
              ok: false,
              error: error.message || "tag_verify_failed"
            }));
          });

        return;
      }

      try {
        const response = await lockerService.processDeviceEnvelope(envelope, context);

        await sendJson(ws, response);
        await sendPendingCommands(ws);
      } catch (error) {
        console.error("Nie udalo sie obsluzyc wiadomosci WebSocket urzadzenia.", {
          deviceId: ws.deviceId,
          connectionId: ws.connectionId,
          error: error.message
        });
        await sendJson(ws, {
          type: "ack",
          messageId: envelope.messageId || null,
          ok: false,
          error: "server_message_handler_failed",
          serverTime: new Date().toISOString()
        });
      }
    });

    ws.on("close", async (_code, reason) => {
      clients.delete(ws.connectionId);
      await lockerService.markDeviceDisconnected(
        ws.deviceId,
        reason?.toString("utf8") || "websocket_closed",
        { connectionId: ws.connectionId }
      );
    });

    ws.on("error", error => {
      console.error("Blad WebSocket urzadzenia.", {
        deviceId: ws.deviceId,
        connectionId: ws.connectionId,
        error: error.message
      });
    });

    await sendJson(ws, {
      type: "server.hello",
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      serverTime: new Date().toISOString(),
      connectionId: ws.connectionId,
      resyncRequired: true
    });

    await sendPendingCommands(ws, { forceRedelivery: true });
  });

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }, DEVICE_WS_PING_INTERVAL_MS);

  lockerService.on("remote-action-queued", () => {
    for (const ws of clients.values()) {
      sendPendingCommands(ws).catch(error => {
        console.error("Nie udalo sie wyslac polecenia przez WebSocket.", error);
      });
    }
  });

  wss.on("close", () => {
    clearInterval(pingTimer);
  });

  return {
    path: DEVICE_WS_PATH,
    close: () => {
      clearInterval(pingTimer);
      wss.close();
    }
  };
}

module.exports = {
  attachDeviceWebSocketTransport
};
