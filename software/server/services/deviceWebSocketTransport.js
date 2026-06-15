const crypto = require("crypto");
const { WebSocket, WebSocketServer } = require("ws");
const {
  buildAck,
  buildCodeVerifyResult,
  buildLockerStatusResult,
  buildTagVerifyResult,
  DEFAULT_DEVICE_ID,
  DEVICE_PROTOCOL_VERSION,
  normalizeDeviceId
} = require("./deviceProtocol");

const DEVICE_WS_PATH = process.env.DEVICE_WS_PATH || "/device/ws";
const DEVICE_WS_PING_INTERVAL_MS = Number(process.env.DEVICE_WS_PING_INTERVAL_MS) || 10 * 1000;
const DEVICE_WS_PING_GRACE_MS = Number(process.env.DEVICE_WS_PING_GRACE_MS) || 15 * 1000;
const DEVICE_WS_HELLO_TIMEOUT_MS = Number(process.env.DEVICE_WS_HELLO_TIMEOUT_MS) || 10 * 1000;
const DEVICE_WS_SERVER_HELLO_DELAY_MS = Number(process.env.DEVICE_WS_SERVER_HELLO_DELAY_MS) || 50;
const SAFE_HEX_BYTES = 24;

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

function getRemoteAddress(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || null;
}

function getPayloadLength(rawMessage) {
  if (Buffer.isBuffer(rawMessage)) {
    return rawMessage.length;
  }

  if (rawMessage instanceof ArrayBuffer) {
    return rawMessage.byteLength;
  }

  if (Array.isArray(rawMessage)) {
    return rawMessage.reduce((sum, chunk) => sum + getPayloadLength(chunk), 0);
  }

  return Buffer.byteLength(String(rawMessage || ""));
}

function toBuffer(rawMessage) {
  if (Buffer.isBuffer(rawMessage)) {
    return rawMessage;
  }

  if (rawMessage instanceof ArrayBuffer) {
    return Buffer.from(rawMessage);
  }

  if (Array.isArray(rawMessage)) {
    return Buffer.concat(rawMessage.map(toBuffer));
  }

  return Buffer.from(String(rawMessage || ""), "utf8");
}

function toSafeHex(value, limit = SAFE_HEX_BYTES) {
  return toBuffer(value).subarray(0, limit).toString("hex");
}

function logDeviceHandshake(req, url, { authorized }) {
  console.log("Device WebSocket handshake.", {
    deviceId: normalizeDeviceId(url.searchParams.get("deviceId") || DEFAULT_DEVICE_ID),
    path: url.pathname,
    authorized,
    remoteAddress: getRemoteAddress(req),
    socketRemoteAddress: req.socket?.remoteAddress || null,
    host: req.headers.host || null,
    forwardedProto: req.headers["x-forwarded-proto"] || null,
    forwardedHost: req.headers["x-forwarded-host"] || null,
    userAgent: req.headers["user-agent"] || null,
    upgrade: req.headers.upgrade || null,
    connection: req.headers.connection || null,
    secWebSocketVersion: req.headers["sec-websocket-version"] || null,
    secWebSocketProtocol: req.headers["sec-websocket-protocol"] || null,
    secWebSocketExtensions: req.headers["sec-websocket-extensions"] || null,
    hasDeviceKey: typeof req.headers["x-device-key"] === "string"
  });
}

function attachDeviceWebSocketTransport(server, lockerService, options = {}) {
  const deviceApiKey = options.deviceApiKey || "";
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const clients = new Map();
  const clientsByDeviceId = new Map();

  async function sendJson(ws, payload) {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const body = JSON.stringify(payload);
    console.log("Device WebSocket send.", {
      deviceId: ws.deviceId,
      connectionId: ws.connectionId,
      type: payload?.type || "unknown",
      bytes: Buffer.byteLength(body)
    });
    ws.send(body, { binary: false, compress: false }, error => {
      if (error) {
        console.error("Nie udalo sie wyslac ramki WebSocket do urzadzenia.", {
          deviceId: ws.deviceId,
          connectionId: ws.connectionId,
          type: payload?.type || "unknown",
          error: error.message
        });
      }
    });
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

    console.log("Device WebSocket pending commands delivery.", {
      deviceId: ws.deviceId,
      connectionId: ws.connectionId,
      count: commands.length,
      forceRedelivery
    });

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
      logDeviceHandshake(req, url, { authorized: false });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    logDeviceHandshake(req, url, { authorized: true });

    if (head?.length) {
      console.warn("Device WebSocket upgrade contained pre-read bytes.", {
        deviceId: normalizeDeviceId(url.searchParams.get("deviceId") || DEFAULT_DEVICE_ID),
        bytes: head.length,
        firstBytesHex: toSafeHex(head)
      });
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req, url);
    });
  });

  wss.on("connection", (ws, req, url) => {
    ws.isAlive = true;
    ws.connectionId = crypto.randomUUID();
    ws.deviceId = normalizeDeviceId(url.searchParams.get("deviceId") || DEFAULT_DEVICE_ID);
    ws.connectedAt = Date.now();
    ws.lastPingAt = null;
    ws.lastPongAt = null;
    ws.helloReceivedAt = null;
    ws.lastRawChunkPrefixHex = null;
    ws.lastRawChunkBytes = 0;
    clients.set(ws.connectionId, ws);
    const previous = clientsByDeviceId.get(ws.deviceId);
    clientsByDeviceId.set(ws.deviceId, ws);

    console.log("Device WebSocket connected.", {
      deviceId: ws.deviceId,
      connectionId: ws.connectionId,
      replacedConnectionId: previous && previous !== ws ? previous.connectionId : null,
      remoteAddress: getRemoteAddress(req),
      userAgent: req.headers["user-agent"] || null,
      protocol: ws.protocol || null,
      extensions: ws.extensions || null
    });

    if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) {
      console.warn("Device WebSocket duplicate connection replaced.", {
        deviceId: ws.deviceId,
        oldConnectionId: previous.connectionId,
        newConnectionId: ws.connectionId
      });
      previous.close(4000, "replaced_by_new_connection");
    }

    if (ws._socket) {
      ws._socket.on("data", chunk => {
        ws.lastRawChunkBytes = chunk.length;
        ws.lastRawChunkPrefixHex = chunk.subarray(0, SAFE_HEX_BYTES).toString("hex");
      });
    }

    const helloTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN && !ws.helloReceivedAt) {
        console.warn("Device WebSocket hello timeout.", {
          deviceId: ws.deviceId,
          connectionId: ws.connectionId,
          ageMs: Date.now() - ws.connectedAt,
          timeoutMs: DEVICE_WS_HELLO_TIMEOUT_MS
        });
      }
    }, DEVICE_WS_HELLO_TIMEOUT_MS);

    ws.on("pong", () => {
      ws.isAlive = true;
      ws.lastPongAt = Date.now();
    });

    ws.on("message", async (rawMessage, isBinary) => {
      const payloadLength = getPayloadLength(rawMessage);
      console.log("Device WebSocket message.", {
        deviceId: ws.deviceId,
        connectionId: ws.connectionId,
        messageType: isBinary ? "binary" : "text",
        bytes: payloadLength
      });

      if (isBinary) {
        console.warn("Device WebSocket binary message rejected.", {
          deviceId: ws.deviceId,
          connectionId: ws.connectionId,
          bytes: payloadLength,
          firstBytesHex: toSafeHex(rawMessage)
        });
        await sendJson(ws, {
          type: "ack",
          ok: false,
          error: "binary_not_supported",
          serverTime: new Date().toISOString()
        });
        return;
      }

      let envelope;
      try {
        envelope = JSON.parse(toBuffer(rawMessage).toString("utf8"));
      } catch (error) {
        console.warn("Device WebSocket invalid JSON.", {
          deviceId: ws.deviceId,
          connectionId: ws.connectionId,
          bytes: payloadLength,
          firstBytesHex: toSafeHex(rawMessage),
          error: error.message
        });
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
        remoteAddress: getRemoteAddress(req)
      };

      if (envelope.type === "hello" || envelope.type === "device.hello") {
        ws.helloReceivedAt = Date.now();
        await lockerService.processDeviceEnvelope(envelope, context);
        return;
      }

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

      if (envelope.type === "code.verify") {
        await sendJson(ws, buildAck(envelope));

        lockerService.processDeviceEnvelope(envelope, context)
          .then(async response => {
            const result = buildCodeVerifyResult(envelope, response?.verification || {}, {
              ok: response?.ok !== false,
              error: response?.ok === false ? response?.error : null
            });
            await sendJson(ws, result);
            try {
              await sendPendingCommands(ws);
            } catch (error) {
              console.error("Nie udalo sie wyslac polecen po weryfikacji kodu.", {
                deviceId: ws.deviceId,
                connectionId: ws.connectionId,
                messageId: envelope.messageId || null,
                error: error.message
              });
            }
          })
          .catch(async error => {
            console.error("Nie udalo sie zweryfikowac kodu przez WebSocket.", {
              deviceId: ws.deviceId,
              connectionId: ws.connectionId,
              messageId: envelope.messageId || null,
              error: error.message
            });
            await sendJson(ws, buildCodeVerifyResult(envelope, {}, {
              ok: false,
              error: error.message || "code_verify_failed"
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

    ws.on("close", async (code, reason) => {
      clearTimeout(helloTimeout);
      clients.delete(ws.connectionId);
      const isCurrentDeviceConnection = clientsByDeviceId.get(ws.deviceId) === ws;
      if (isCurrentDeviceConnection) {
        clientsByDeviceId.delete(ws.deviceId);
      }
      console.warn("Device WebSocket zamkniety.", {
        deviceId: ws.deviceId,
        connectionId: ws.connectionId,
        code,
        reason: reason?.toString("utf8") || "",
        ageMs: Date.now() - ws.connectedAt,
        helloReceived: Boolean(ws.helloReceivedAt),
        lastPingAgeMs: ws.lastPingAt ? Date.now() - ws.lastPingAt : null,
        lastPongAgeMs: ws.lastPongAt ? Date.now() - ws.lastPongAt : null,
        lastRawChunkBytes: ws.lastRawChunkBytes || null,
        lastRawChunkPrefixHex: ws.lastRawChunkPrefixHex
      });
      if (isCurrentDeviceConnection) {
        await lockerService.markDeviceDisconnected(
          ws.deviceId,
          reason?.toString("utf8") || "websocket_closed",
          { connectionId: ws.connectionId }
        );
      }
    });

    ws.on("error", error => {
      console.error("Blad WebSocket urzadzenia.", {
        deviceId: ws.deviceId,
        connectionId: ws.connectionId,
        error: error.message,
        lastRawChunkBytes: ws.lastRawChunkBytes || null,
        lastRawChunkPrefixHex: ws.lastRawChunkPrefixHex
      });
    });

    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      lockerService.getDeviceConfig(ws.deviceId)
        .then(deviceConfig => sendJson(ws, {
          type: "server.hello",
          protocolVersion: DEVICE_PROTOCOL_VERSION,
          configVersion: deviceConfig.configVersion,
          connectionId: ws.connectionId,
          resyncRequired: true
        }))
        .catch(error => {
          console.error("Nie udalo sie wyslac server.hello do urzadzenia.", {
            deviceId: ws.deviceId,
            connectionId: ws.connectionId,
            error: error.message
          });
        });
    }, DEVICE_WS_SERVER_HELLO_DELAY_MS);

    // ESP32/links2004 WebSockets is sensitive to back-to-back server frames
    // during connection setup. Keep the initial handshake to server.hello only;
    // queued commands are still delivered by HTTP polling and live WS events.
  });

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      const ageMs = Date.now() - ws.connectedAt;
      if (ageMs < DEVICE_WS_PING_GRACE_MS) {
        continue;
      }

      if (ws.isAlive === false) {
        console.warn("Device WebSocket ping timeout, terminating.", {
          deviceId: ws.deviceId,
          connectionId: ws.connectionId,
          ageMs,
          lastPingAgeMs: ws.lastPingAt ? Date.now() - ws.lastPingAt : null,
          lastPongAgeMs: ws.lastPongAt ? Date.now() - ws.lastPongAt : null
        });
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.lastPingAt = Date.now();
      ws.ping(error => {
        if (error) {
          console.error("Nie udalo sie wyslac ping WebSocket do urzadzenia.", {
            deviceId: ws.deviceId,
            connectionId: ws.connectionId,
            error: error.message
          });
        }
      });
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
