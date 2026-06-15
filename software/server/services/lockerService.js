const crypto = require("crypto");
const { EventEmitter } = require("events");
const mongoose = require("mongoose");
const { Code, DeviceCommand, DeviceConfig, DeviceMessageReceipt, DeviceState, Log, Locker, ReturnSession, RfidUser, RfidItem } = require("../models");
const {
  ALLOWED_LOCKERS,
  RETURN_SESSION_STATUSES,
  assertValidAllowedLockers,
  assertValidCode,
  assertValidDoorClosed,
  assertValidHasTag,
  assertValidHours,
  assertValidLocker,
  assertValidRecipientEmail,
  assertValidRfidItemName,
  assertValidRfidItemType,
  assertValidTagId,
  assertValidUserName,
  createHttpError,
  normalizeAssignedLocker
} = require("./lockerValidation");
const {
  COMMAND_DELIVERABLE_STATUSES,
  COMMAND_TERMINAL_STATUSES,
  DEFAULT_DEVICE_ID,
  DEFAULT_DEVICE_CONFIG,
  DEVICE_PROTOCOL_VERSION,
  buildAck,
  buildDeviceConfigResponse,
  mapCommandForDevice,
  mapCommandForHistory,
  normalizeCommandAckPayload,
  normalizeDeviceConfig,
  normalizeDeviceDiagnosticPayload,
  normalizeDeviceLogPayload,
  normalizeString,
  normalizeDeviceId,
  normalizeMessageId,
  normalizeSequence
} = require("./deviceProtocol");
const {
  RETURN_ACTIVE_STATUSES,
  RETURN_ITEM_ACTIVE_STATUSES,
  RETURN_COMPLETION_STATUSES,
  isActiveReturnStatus,
  isReturnEligibleItem,
  mapReturnSession,
  normalizeRfidItemPayload
} = require("./returnFlow");

const MASTER_RFID_ITEM_TYPES = new Set(["klucz_master", "karta_master"]);
const DEVICE_HEARTBEAT_TIMEOUT_MS = Number(process.env.DEVICE_HEARTBEAT_TIMEOUT_MS) || 180 * 1000;
const DEVICE_COMMAND_REDELIVER_AFTER_MS = Number(process.env.DEVICE_COMMAND_REDELIVER_AFTER_MS) || 30 * 1000;
const DEVICE_COMMAND_DELIVERY_LIMIT = Number(process.env.DEVICE_COMMAND_DELIVERY_LIMIT) || 20;
const RETURN_SESSION_TIMEOUT_MS = Math.max(
  30000,
  Math.min(Number(process.env.RETURN_SESSION_TIMEOUT_MS) || 120000, 300000)
);
const ENABLE_DOOR_SENSORS = /^(1|true|yes|on)$/i.test(String(process.env.ENABLE_DOOR_SENSORS || "false"));
const ACCESS_SELECTION_EVENTS = new Set([
  "access_selection_started",
  "access_selection_cancelled",
  "access_selection_timeout",
  "access_selection_invalid_locker",
  "access_selection_open_single",
  "access_selection_open_all",
  "access_denied_no_lockers",
  "access_selection_busy",
  "invalid_selection_key"
]);

function isMasterRfidItemType(itemType) {
  return MASTER_RFID_ITEM_TYPES.has(itemType);
}

function buildAccessMask(lockers = []) {
  return lockers.reduce((mask, locker) => {
    if (!Number.isInteger(locker) || locker < 1 || locker > ALLOWED_LOCKERS.length) {
      return mask;
    }

    return mask | (1 << (locker - 1));
  }, 0);
}

function maskToLockers(mask) {
  const numericMask = Number(mask) & ((1 << ALLOWED_LOCKERS.length) - 1);
  return ALLOWED_LOCKERS.filter(locker => (numericMask & (1 << (locker - 1))) !== 0);
}

function normalizeAccessSelectionEvent(value) {
  const event = normalizeString(value);
  if (!ACCESS_SELECTION_EVENTS.has(event)) {
    throw createHttpError(400, "Nieznany typ zdarzenia access selection.");
  }
  return event;
}

function buildAccessSelectionActor(userName, tagId, fallback = "RFID access selection") {
  const normalizedName = normalizeString(userName, "");
  const normalizedTagId = normalizeString(tagId, "");

  if (normalizedName && normalizedTagId) {
    return `${normalizedName} • ${normalizedTagId}`;
  }

  return normalizedName || normalizedTagId || fallback;
}

function getLockerItemStatus(locker = {}) {
  const hasTag = locker.hasTag === true;
  const detectedItemKnown = typeof locker.detectedItemKnown === "boolean"
    ? locker.detectedItemKnown
    : (typeof locker.itemKnown === "boolean" ? locker.itemKnown : null);
  const detectedItemName = locker.detectedItemName || locker.itemName || null;
  const detectedTagId = locker.detectedTagId || locker.tagId || locker.tagUid || null;

  if (!hasTag) {
    return "missing";
  }

  if (detectedItemKnown === true && detectedItemName) {
    return "known";
  }

  if (detectedTagId || detectedItemKnown === false) {
    return "unknown";
  }

  return "unknown";
}

function getLockerSeverity(locker = {}) {
  const itemStatus = locker.itemStatus || getLockerItemStatus(locker);
  const isDoorClosed = locker.isDoorClosed !== false;

  if (itemStatus === "unknown") {
    return "critical";
  }

  if (itemStatus === "known" && isDoorClosed) {
    return "ok";
  }

  if (itemStatus === "missing" && !isDoorClosed) {
    return "critical";
  }

  return "warn";
}

function getLockerItemLabel(locker = {}) {
  const itemStatus = getLockerItemStatus(locker);
  const detectedItemName = locker.detectedItemName || locker.itemName || null;

  if (itemStatus === "known" && detectedItemName) {
    return detectedItemName;
  }

  if (itemStatus === "missing") {
    return "Brak klucza";
  }

  return "Obcy przedmiot";
}

function buildLockerStatePayload(locker = {}) {
  const lockerNumber = Number(locker.locker || locker.lockerId);
  const hasTag = locker.hasTag === true;
  const isDoorClosed = locker.isDoorClosed !== false;
  const detectedTagId = locker.detectedTagId || locker.tagId || locker.tagUid || null;
  const detectedItemName = locker.detectedItemName || locker.itemName || null;
  const detectedItemType = locker.detectedItemType || locker.itemType || null;
  const detectedItemKnown = typeof locker.detectedItemKnown === "boolean"
    ? locker.detectedItemKnown
    : (typeof locker.itemKnown === "boolean" ? locker.itemKnown : null);
  const detectedAt = locker.detectedAt || null;
  const itemStatus = getLockerItemStatus({
    hasTag,
    detectedTagId,
    detectedItemName,
    detectedItemKnown
  });

  const payload = {
    locker: lockerNumber,
    lockerId: lockerNumber,
    hasTag,
    isDoorClosed,
    detectedTagId,
    detectedItemName,
    detectedItemType,
    detectedItemKnown,
    detectedAt,
    tagUid: detectedTagId,
    itemName: detectedItemName,
    itemType: detectedItemType,
    itemKnown: detectedItemKnown,
    itemStatus,
    itemLabel: getLockerItemLabel({
      hasTag,
      detectedTagId,
      detectedItemName,
      detectedItemKnown
    }),
    source: locker.source || null
  };

  payload.severity = getLockerSeverity(payload);
  return payload;
}

function parseGenerateCodeInput(lockerOrPayload, hours) {
  if (typeof lockerOrPayload === "object" && lockerOrPayload !== null) {
    return {
      locker: Number(lockerOrPayload.locker),
      hours: Number(lockerOrPayload.hours),
      recipientEmail: assertValidRecipientEmail(lockerOrPayload.recipientEmail || lockerOrPayload.email)
    };
  }

  return {
    locker: lockerOrPayload,
    hours,
    recipientEmail: null
  };
}

function normalizeEmailError(error) {
  if (!error) {
    return "Nie udało się wysłać wiadomości e-mail.";
  }

  if (error.code === "ETIMEDOUT") {
    return "Polaczenie z serwerem SMTP przekroczylo limit czasu. Sprawdz host, port oraz to, czy hosting pozwala na ruch SMTP.";
  }

  if (error.code === "ENOTFOUND") {
    return "Nie udalo sie odnalezc serwera SMTP. Sprawdz adres SMTP_HOST.";
  }

  if (error.code === "ECONNREFUSED") {
    return "Serwer SMTP odrzucil polaczenie. Sprawdz port oraz ustawienie SMTP_SECURE.";
  }

  if (error.code === "EAUTH") {
    return "Logowanie do SMTP nie powiodlo sie. Sprawdz SMTP_USER i SMTP_PASS.";
  }

  if (error.code === "BREVO_API_ERROR") {
    if (error.responseStatus === 401 || error.responseStatus === 403) {
      return "Brevo API odrzucilo autoryzacje. Sprawdz BREVO_API_KEY.";
    }

    if (error.responseStatus === 400) {
      return "Brevo API odrzucilo zadanie. Sprawdz nadawce i konfiguracje danych e-mail.";
    }

    return `Brevo API zwrocilo blad HTTP ${error.responseStatus || "nieznany"}.`;
  }

  const message = typeof error.message === "string" ? error.message : "";

  if (!message.trim()) {
    return "Nie udało się wysłać wiadomości e-mail.";
  }

  return message.trim().slice(0, 240);
}

class LockerService extends EventEmitter {
  constructor() {
    super();
    this.pendingRemoteActions = [];
    this.remoteActionHistory = [];
    this.pendingRemoteActionWaiters = [];
    this.emailService = null;
    this.currentTagAssignment = null;
    this.deviceStatus = {
      deviceId: DEFAULT_DEVICE_ID,
      connected: false,
      lastSeenAt: null,
      pingMs: null,
      wifiRssi: null,
      ip: null,
      firmware: null,
      uptimeMs: null,
      freeHeap: null,
      minFreeHeap: null,
      transport: null,
      connectionId: null,
      bootId: null,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      networkFailureCount: null,
      configVersion: 1,
      servicePanelIp: null,
      servicePanelActive: null
    };
  }

  setEmailService(emailService) {
    this.emailService = emailService;
  }

  async hydrateRuntimeState() {
    const [deviceState, latestAssignmentCommand] = await Promise.all([
      DeviceState.findOne({ deviceId: DEFAULT_DEVICE_ID }).lean(),
      DeviceCommand.findOne({
        type: "ASSIGN_RFID_TAG",
        status: { $in: COMMAND_DELIVERABLE_STATUSES }
      }).sort({ createdAt: -1 }).lean()
    ]);

    if (deviceState) {
      this.deviceStatus = {
        ...this.deviceStatus,
        deviceId: deviceState.deviceId,
        connected: false,
        lastSeenAt: deviceState.lastSeenAt ? deviceState.lastSeenAt.toISOString() : null,
        pingMs: deviceState.pingMs ?? null,
        wifiRssi: deviceState.wifiRssi ?? null,
        ip: deviceState.ip || null,
        firmware: deviceState.firmware || null,
        uptimeMs: deviceState.uptimeMs ?? null,
        freeHeap: deviceState.freeHeap ?? null,
        minFreeHeap: deviceState.minFreeHeap ?? null,
        transport: deviceState.transport || null,
        connectionId: null,
        bootId: deviceState.bootId || null,
        protocolVersion: deviceState.protocolVersion || DEVICE_PROTOCOL_VERSION,
        networkFailureCount: deviceState.networkFailureCount ?? null,
        configVersion: deviceState.configVersion || 1,
        servicePanelIp: deviceState.servicePanelIp || null,
        servicePanelActive: typeof deviceState.servicePanelActive === "boolean" ? deviceState.servicePanelActive : null
      };
    }

    if (latestAssignmentCommand?.payload?.assignmentId && latestAssignmentCommand?.payload?.tagId) {
      this.currentTagAssignment = {
        id: latestAssignmentCommand.payload.assignmentId,
        itemName: latestAssignmentCommand.payload.itemName || null,
        tagId: latestAssignmentCommand.payload.tagId,
        status: "pending",
        createdAt: latestAssignmentCommand.createdAt?.toISOString?.() || new Date().toISOString(),
        startedBy: latestAssignmentCommand.actor || "system",
        result: null
      };
    }
  }

  getDeviceStatusSnapshot() {
    const lastSeenAt = this.deviceStatus.lastSeenAt
      ? new Date(this.deviceStatus.lastSeenAt)
      : null;
    const connected = Boolean(lastSeenAt)
      && this.deviceStatus.connected !== false
      && (Date.now() - lastSeenAt.getTime()) <= DEVICE_HEARTBEAT_TIMEOUT_MS;

    return {
      connected,
      deviceId: this.deviceStatus.deviceId || DEFAULT_DEVICE_ID,
      lastSeenAt: this.deviceStatus.lastSeenAt,
      pingMs: this.deviceStatus.pingMs,
      wifiRssi: this.deviceStatus.wifiRssi,
      ip: this.deviceStatus.ip,
      firmware: this.deviceStatus.firmware,
      uptimeMs: this.deviceStatus.uptimeMs,
      freeHeap: this.deviceStatus.freeHeap,
      minFreeHeap: this.deviceStatus.minFreeHeap,
      transport: this.deviceStatus.transport,
      connectionId: this.deviceStatus.connectionId,
      bootId: this.deviceStatus.bootId,
      protocolVersion: this.deviceStatus.protocolVersion,
      networkFailureCount: this.deviceStatus.networkFailureCount,
      configVersion: this.deviceStatus.configVersion,
      servicePanelIp: this.deviceStatus.servicePanelIp,
      servicePanelActive: this.deviceStatus.servicePanelActive
    };
  }

  async markDeviceConnected(payload = {}, context = {}) {
    const deviceId = normalizeDeviceId(payload.deviceId || context.deviceId);
    const now = new Date();
    const previousConnected = this.getDeviceStatusSnapshot().connected;
    const update = {
      connected: true,
      transport: context.transport || "websocket",
      connectionId: context.connectionId || null,
      bootId: payload.bootId || this.deviceStatus.bootId || null,
      protocolVersion: Number(payload.protocolVersion) || DEVICE_PROTOCOL_VERSION,
      lastSeenAt: now,
      lastConnectedAt: now,
      disconnectReason: null,
      firmware: payload.firmware || this.deviceStatus.firmware || null,
      ip: payload.ip || this.deviceStatus.ip || null,
      wifiRssi: typeof payload.wifiRssi === "number" ? payload.wifiRssi : this.deviceStatus.wifiRssi,
      uptimeMs: typeof payload.uptimeMs === "number" ? payload.uptimeMs : this.deviceStatus.uptimeMs,
      freeHeap: typeof payload.freeHeap === "number" ? payload.freeHeap : this.deviceStatus.freeHeap,
      minFreeHeap: typeof payload.minFreeHeap === "number" ? payload.minFreeHeap : this.deviceStatus.minFreeHeap,
      networkFailureCount: typeof payload.networkFailureCount === "number"
        ? payload.networkFailureCount
        : this.deviceStatus.networkFailureCount,
      configVersion: typeof payload.configVersion === "number" ? payload.configVersion : this.deviceStatus.configVersion,
      servicePanelIp: typeof payload.servicePanelIp === "string" ? payload.servicePanelIp : this.deviceStatus.servicePanelIp,
      servicePanelActive: typeof payload.servicePanelActive === "boolean" ? payload.servicePanelActive : this.deviceStatus.servicePanelActive
    };

    await DeviceState.findOneAndUpdate(
      { deviceId },
      { $set: update, $setOnInsert: { deviceId } },
      { upsert: true, returnDocument: "after" }
    );

    this.deviceStatus = {
      ...this.deviceStatus,
      ...update,
      deviceId,
      lastSeenAt: now.toISOString(),
      lastConnectedAt: now.toISOString()
    };

    this.emit("device-status-changed", {
      status: this.getDeviceStatusSnapshot(),
      wasConnected: previousConnected
    });

    return this.getDeviceStatusSnapshot();
  }

  async markDeviceDisconnected(deviceId = DEFAULT_DEVICE_ID, reason = "transport_closed", context = {}) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (context.connectionId && this.deviceStatus.connectionId && context.connectionId !== this.deviceStatus.connectionId) {
      return;
    }

    const now = new Date();

    await DeviceState.findOneAndUpdate(
      {
        deviceId: normalizedDeviceId,
        ...(context.connectionId ? { connectionId: context.connectionId } : {})
      },
      {
        $set: {
          connected: false,
          connectionId: null,
          lastDisconnectedAt: now,
          disconnectReason: String(reason || "transport_closed").slice(0, 120)
        }
      },
      { returnDocument: "after" }
    );

    this.deviceStatus = {
      ...this.deviceStatus,
      deviceId: normalizedDeviceId,
      connected: false,
      connectionId: null,
      lastDisconnectedAt: now.toISOString(),
      disconnectReason: String(reason || "transport_closed").slice(0, 120)
    };

    this.emit("device-status-changed", {
      status: this.getDeviceStatusSnapshot(),
      wasConnected: true
    });
  }

  async updateDeviceHeartbeat(payload = {}, context = {}) {
    const deviceId = normalizeDeviceId(payload.deviceId || context.deviceId);
    const now = new Date();
    const previousConnected = this.getDeviceStatusSnapshot().connected;
    const sequence = normalizeSequence(context.sequence ?? payload.seq);
    const update = {
      connected: true,
      transport: context.transport || payload.transport || this.deviceStatus.transport || "https",
      connectionId: context.connectionId || this.deviceStatus.connectionId || null,
      bootId: payload.bootId || this.deviceStatus.bootId || null,
      protocolVersion: Number(payload.protocolVersion) || this.deviceStatus.protocolVersion || DEVICE_PROTOCOL_VERSION,
      lastSeenAt: now,
      pingMs: typeof payload.pingMs === "number" ? payload.pingMs : null,
      wifiRssi: typeof payload.wifiRssi === "number" ? payload.wifiRssi : null,
      ip: typeof payload.ip === "string" ? payload.ip : null,
      firmware: typeof payload.firmware === "string" ? payload.firmware : null,
      uptimeMs: typeof payload.uptimeMs === "number" ? payload.uptimeMs : null,
      freeHeap: typeof payload.freeHeap === "number" ? payload.freeHeap : null,
      minFreeHeap: typeof payload.minFreeHeap === "number" ? payload.minFreeHeap : null,
      lockersWithTags: typeof payload.lockersWithTags === "number" ? payload.lockersWithTags : null,
      masterReaderPresent: typeof payload.masterReaderPresent === "boolean" ? payload.masterReaderPresent : null,
      networkFailureCount: typeof payload.networkFailureCount === "number" ? payload.networkFailureCount : null,
      configVersion: typeof payload.configVersion === "number" ? payload.configVersion : this.deviceStatus.configVersion,
      servicePanelIp: typeof payload.servicePanelIp === "string" ? payload.servicePanelIp : this.deviceStatus.servicePanelIp,
      servicePanelActive: typeof payload.servicePanelActive === "boolean" ? payload.servicePanelActive : this.deviceStatus.servicePanelActive,
      lastMessageId: context.messageId || this.deviceStatus.lastMessageId || null
    };

    if (sequence !== null) {
      update.lastSequence = sequence;
    }

    await DeviceState.findOneAndUpdate(
      { deviceId },
      { $set: update, $setOnInsert: { deviceId } },
      { upsert: true, returnDocument: "after" }
    );

    this.deviceStatus = {
      ...this.deviceStatus,
      ...update,
      deviceId,
      lastSeenAt: now.toISOString()
    };

    this.emit("device-status-changed", {
      status: this.getDeviceStatusSnapshot(),
      wasConnected: previousConnected
    });

    return this.getDeviceStatusSnapshot();
  }

  async processDeviceEnvelope(envelope = {}, context = {}) {
    const type = typeof envelope.type === "string" ? envelope.type.trim() : "";
    const deviceId = normalizeDeviceId(envelope.deviceId || context.deviceId);
    const messageId = normalizeMessageId(envelope.messageId);
    const sequence = normalizeSequence(envelope.seq ?? envelope.sequence);

    if (!type) {
      return buildAck(envelope, {
        ok: false,
        error: "missing_message_type"
      });
    }

    if (messageId) {
      const existingReceipt = await DeviceMessageReceipt.findOne({ messageId }).lean();
      if (existingReceipt) {
        return {
          ...existingReceipt.response,
          duplicate: true
        };
      }
    }

    let response;
    try {
      switch (type) {
        case "hello":
        case "device.hello": {
          await this.markDeviceConnected(envelope.payload || envelope, {
            ...context,
            deviceId,
            sequence,
            messageId
          });
          response = buildAck(envelope, {
            protocolVersion: DEVICE_PROTOCOL_VERSION,
            resyncRequired: true
          });
          break;
        }

        case "heartbeat": {
          await this.updateDeviceHeartbeat(envelope.payload || {}, {
            ...context,
            deviceId,
            sequence,
            messageId
          });
          const deviceConfig = await this.getDeviceConfig(deviceId);
          response = buildAck(envelope, {
            protocolVersion: DEVICE_PROTOCOL_VERSION,
            configVersion: deviceConfig.configVersion,
            config: deviceConfig.config
          });
          break;
        }

        case "config.request": {
          const deviceConfig = await this.getDeviceConfig(deviceId);
          response = buildAck(envelope, {
            protocolVersion: DEVICE_PROTOCOL_VERSION,
            configVersion: deviceConfig.configVersion,
            config: deviceConfig.config
          });
          break;
        }

        case "device.log": {
          await this.recordDeviceLog({
            ...(envelope.payload || {}),
            deviceId
          }, {
            ...context,
            deviceId
          });
          response = buildAck(envelope);
          break;
        }

        case "diagnostic.result": {
          await this.recordDeviceDiagnostic({
            ...(envelope.payload || {}),
            deviceId
          }, {
            ...context,
            deviceId
          });
          response = buildAck(envelope);
          break;
        }

        case "state.batch": {
          const result = await this.processDeviceStateBatch(envelope.payload || {}, {
            ...context,
            deviceId,
            sequence,
            messageId,
            bootId: envelope.bootId || envelope.payload?.bootId || null
          });
          response = buildAck(envelope, {
            state: result
          });
          break;
        }

        case "code.verify": {
          const verification = await this.verifyCode(envelope.payload?.code, {
            source: "device",
            actor: deviceId
          });
          response = buildAck(envelope, {
            verification
          });
          break;
        }

        case "tag.verify": {
          const tagVerification = await this.verifyRfidTag(envelope.payload?.tagId, {
            source: "device",
            actor: deviceId
          });
          response = buildAck(envelope, {
            tagVerification
          });
          break;
        }

        case "access.selection": {
          const selectionResult = await this.handleAccessSelectionEvent(envelope.payload || {}, {
            source: "device",
            actor: deviceId
          });
          response = buildAck(envelope, {
            accessSelection: selectionResult
          });
          break;
        }

        case "return.progress": {
          const returnSession = await this.handleReturnProgress(envelope.payload || {}, {
            source: "device",
            actor: deviceId,
            deviceId
          });
          response = buildAck(envelope, {
            returnSession
          });
          break;
        }

        case "command.ack": {
          const ackPayload = normalizeCommandAckPayload(envelope.payload || {});
          if (!ackPayload.commandId) {
            response = buildAck(envelope, {
              ok: false,
              error: "missing_command_id"
            });
            break;
          }

          const action = await this.acknowledgeRemoteAction(ackPayload.commandId, ackPayload, {
            ...context,
            deviceId
          });
          response = buildAck(envelope, {
            command: action
          });
          break;
        }

        case "tag.assignment.result": {
          const result = await this.completeTagAssignment(envelope.payload || {}, {
            source: "device",
            actor: envelope.payload?.physicalUid || deviceId
          });
          response = buildAck(envelope, {
            assignment: result
          });
          break;
        }

        default:
          response = buildAck(envelope, {
            ok: false,
            error: "unsupported_message_type"
          });
      }
    } catch (error) {
      response = buildAck(envelope, {
        ok: false,
        error: error.message || "device_message_failed"
      });
    }

    if (messageId) {
      try {
        await DeviceMessageReceipt.create({
          messageId,
          deviceId,
          type,
          sequence,
          status: response.ok === false ? "rejected" : "processed",
          response
        });
      } catch (error) {
        if (error?.code === 11000) {
          const existingReceipt = await DeviceMessageReceipt.findOne({ messageId }).lean();
          if (existingReceipt) {
            return {
              ...existingReceipt.response,
              duplicate: true
            };
          }
        }

        throw error;
      }
    }

    return response;
  }

  async processDeviceSync(messages = [], context = {}) {
    if (!Array.isArray(messages)) {
      throw createHttpError(400, "Pole messages musi byc tablica.");
    }

    const responses = [];
    for (const message of messages.slice(0, 25)) {
      responses.push(await this.processDeviceEnvelope(message, {
        ...context,
        transport: context.transport || "https-batch"
      }));
    }

    return {
      ok: responses.every(response => response.ok !== false),
      serverTime: new Date().toISOString(),
      responses
    };
  }

  async getDeviceConfig(deviceId = DEFAULT_DEVICE_ID) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const existing = await DeviceConfig.findOne({ deviceId: normalizedDeviceId }).lean();
    if (!existing) {
      return buildDeviceConfigResponse(normalizedDeviceId, DEFAULT_DEVICE_CONFIG, {
        configVersion: 1
      });
    }

    return buildDeviceConfigResponse(normalizedDeviceId, existing.config || DEFAULT_DEVICE_CONFIG, {
      configVersion: existing.version || 1
    });
  }

  async updateDeviceConfig(payload = {}, context = {}) {
    const deviceId = normalizeDeviceId(payload.deviceId || DEFAULT_DEVICE_ID);
    const existing = await DeviceConfig.findOne({ deviceId }).lean();
    const previousConfig = existing?.config || DEFAULT_DEVICE_CONFIG;
    const incomingConfig = payload.config || payload;
    const nextConfig = normalizeDeviceConfig({
      ...previousConfig,
      ...incomingConfig,
      remoteLogging: {
        ...(previousConfig.remoteLogging || {}),
        ...(incomingConfig.remoteLogging || {})
      },
      codeRateLimit: {
        ...(previousConfig.codeRateLimit || {}),
        ...(incomingConfig.codeRateLimit || {})
      },
      servicePanel: {
        ...(previousConfig.servicePanel || {}),
        ...(incomingConfig.servicePanel || {})
      },
      doorSensors: {
        ...(previousConfig.doorSensors || {}),
        ...(incomingConfig.doorSensors || {})
      },
      ota: {
        ...(previousConfig.ota || {}),
        ...(incomingConfig.ota || {})
      },
      diagnostics: {
        ...(previousConfig.diagnostics || {}),
        ...(incomingConfig.diagnostics || {})
      }
    });
    const nextVersion = (existing?.version || 1) + 1;

    await DeviceConfig.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          config: nextConfig,
          version: nextVersion,
          updatedBy: context.actor || null
        },
        $setOnInsert: {
          deviceId
        }
      },
      { upsert: true, returnDocument: "after" }
    );

    await this.createLog({
      event: "DEVICE_CONFIG_UPDATED",
      source: context.source || "web",
      actor: context.actor || "system",
      details: {
        deviceId,
        version: nextVersion,
        config: nextConfig
      }
    });

    this.emit("device-config-updated", {
      deviceId,
      version: nextVersion,
      config: nextConfig
    });

    return buildDeviceConfigResponse(deviceId, nextConfig, {
      configVersion: nextVersion
    });
  }

  async recordDeviceLog(payload = {}, context = {}) {
    const deviceId = normalizeDeviceId(payload.deviceId || context.deviceId);
    const normalized = normalizeDeviceLogPayload(payload);
    return this.createLog({
      event: "DEVICE_LOG",
      source: context.source || "device",
      actor: deviceId,
      success: normalized.level !== "error",
      errorMessage: normalized.level === "error" ? normalized.message || normalized.event : null,
      details: {
        level: normalized.level,
        event: normalized.event,
        message: normalized.message,
        firmware: normalized.firmware,
        protocolVersion: normalized.protocolVersion,
        uptimeMs: normalized.uptimeMs,
        freeHeap: normalized.freeHeap,
        details: normalized.details
      }
    });
  }

  async recordDeviceDiagnostic(payload = {}, context = {}) {
    const deviceId = normalizeDeviceId(payload.deviceId || context.deviceId);
    const normalized = normalizeDeviceDiagnosticPayload(payload);
    return this.createLog({
      event: "DEVICE_DIAGNOSTIC",
      source: context.source || "device",
      actor: deviceId,
      success: normalized.ok,
      errorMessage: normalized.ok ? null : normalized.message || normalized.name,
      details: {
        name: normalized.name,
        message: normalized.message,
        firmware: normalized.firmware,
        protocolVersion: normalized.protocolVersion,
        uptimeMs: normalized.uptimeMs,
        details: normalized.details
      }
    });
  }

  async processDeviceStateBatch(payload = {}, context = {}) {
    const deviceId = normalizeDeviceId(context.deviceId || payload.deviceId);
    const lockers = Array.isArray(payload.lockers) ? payload.lockers : [];
    const now = new Date();
    const startedAt = Date.now();
    const normalizedLockers = lockers.slice(0, ALLOWED_LOCKERS.length).map(item => {
      const locker = Number(item.locker);
      assertValidLocker(locker);
      assertValidHasTag(item.hasTag);

      return {
        locker,
        hasTag: item.hasTag,
        tagId: typeof item.tagId === "string" && item.tagId.trim()
          ? assertValidTagId(item.tagId.trim().toUpperCase())
          : null,
        doorClosed: typeof item.doorClosed === "boolean" ? item.doorClosed : null,
        lockClosed: typeof item.lockClosed === "boolean" ? item.lockClosed : null,
        version: Number.isSafeInteger(Number(item.version))
          ? Number(item.version)
          : (normalizeSequence(context.sequence) || 0)
      };
    });
    const tagIds = [...new Set(normalizedLockers
      .filter(item => item.hasTag && item.tagId)
      .map(item => item.tagId))];
    const [stateDoc, lockerDocs, knownItems] = await Promise.all([
      DeviceState.findOne({ deviceId }).lean(),
      Locker.find({ locker: { $in: ALLOWED_LOCKERS } }).lean(),
      tagIds.length > 0
        ? RfidItem.find({ tagId: { $in: tagIds }, active: true }).lean()
        : Promise.resolve([])
    ]);
    const previousVersions = new Map(
      (stateDoc?.lockers || []).map(item => [Number(item.locker), Number(item.version) || 0])
    );
    const accepted = [];
    const lockerByNumber = new Map(lockerDocs.map(item => [Number(item.locker), item]));
    const knownItemByTagId = new Map(knownItems.map(item => [item.tagId, item]));
    const storedLockers = new Map(
      (stateDoc?.lockers || []).map(item => [Number(item.locker), {
        locker: Number(item.locker),
        hasTag: item.hasTag === true,
        tagId: item.tagId || null,
        doorClosed: typeof item.doorClosed === "boolean" ? item.doorClosed : null,
        lockClosed: typeof item.lockClosed === "boolean" ? item.lockClosed : null,
        version: Number(item.version) || 0,
        updatedAt: item.updatedAt || now
      }])
    );
    const forceFull = payload.full === true;
    const lockerWrites = [];
    const logWrites = [];
    const lockerEvents = [];
    const returnObservations = [];

    const describeKnownTag = tagId => {
      if (!tagId) {
        return {
          tagId: null,
          itemName: null,
          itemType: null,
          itemKnown: null
        };
      }

      const item = knownItemByTagId.get(tagId);
      if (!item) {
        return {
          tagId,
          itemName: null,
          itemType: null,
          itemKnown: false
        };
      }

      return {
        tagId: item.tagId,
        itemName: item.name,
        itemType: item.itemType,
        itemKnown: true
      };
    };

    for (const item of normalizedLockers) {
      const locker = item.locker;
      const incomingVersion = item.version;
      const previousVersion = previousVersions.get(locker) || 0;
      const shouldApply = forceFull || incomingVersion >= previousVersion;

      if (!shouldApply) {
        accepted.push({
          locker,
          accepted: false,
          reason: "stale_version",
          version: incomingVersion,
          currentVersion: previousVersion
        });
        continue;
      }

      const source = context.transport === "websocket" ? "device-ws" : "device-sync";
      const existingLocker = lockerByNumber.get(locker) || null;
      const previousItem = existingLocker
        ? {
            tagId: existingLocker.detectedTagId || null,
            itemName: existingLocker.detectedItemName || null,
            itemType: existingLocker.detectedItemType || null,
            itemKnown: typeof existingLocker.detectedItemKnown === "boolean" ? existingLocker.detectedItemKnown : null
          }
        : null;
      const nextItem = item.hasTag
        ? (item.tagId ? describeKnownTag(item.tagId) : previousItem)
        : {
            tagId: null,
            itemName: null,
            itemType: null,
            itemKnown: null
          };
      const statusChanged = !existingLocker || existingLocker.hasTag !== item.hasTag;
      const itemChanged = previousItem?.tagId !== nextItem?.tagId
        || previousItem?.itemName !== nextItem?.itemName
        || previousItem?.itemType !== nextItem?.itemType
        || previousItem?.itemKnown !== nextItem?.itemKnown;
      const hasDoorSignal = item.doorClosed !== null || item.lockClosed !== null;
      const isDoorClosed = hasDoorSignal
        ? item.doorClosed !== false && item.lockClosed !== false
        : null;
      const previousDoorClosed = existingLocker ? existingLocker.isDoorClosed !== false : null;
      const doorChanged = hasDoorSignal && (!existingLocker || previousDoorClosed !== isDoorClosed);
      const resolvedLockerState = buildLockerStatePayload({
        locker,
        hasTag: item.hasTag,
        isDoorClosed: hasDoorSignal
          ? isDoorClosed
          : (existingLocker ? existingLocker.isDoorClosed !== false : true),
        detectedTagId: nextItem?.tagId || null,
        detectedItemName: nextItem?.itemName || null,
        detectedItemType: nextItem?.itemType || null,
        detectedItemKnown: typeof nextItem?.itemKnown === "boolean" ? nextItem.itemKnown : null,
        detectedAt: item.hasTag ? now : null,
        source
      });

      if (statusChanged || itemChanged || doorChanged) {
        const set = {
          locker,
          hasTag: item.hasTag,
          detectedTagId: nextItem?.tagId || null,
          detectedItemName: nextItem?.itemName || null,
          detectedItemType: nextItem?.itemType || null,
          detectedItemKnown: typeof nextItem?.itemKnown === "boolean" ? nextItem.itemKnown : null,
          detectedAt: item.hasTag ? now : null
        };

        if (hasDoorSignal) {
          set.isDoorClosed = isDoorClosed;
        } else if (!existingLocker) {
          set.isDoorClosed = true;
        }

        lockerWrites.push({
          updateOne: {
            filter: { locker },
            update: {
              $set: set
            },
            upsert: true
          }
        });
      }

      if (existingLocker && existingLocker.hasTag === true && item.hasTag === false) {
        logWrites.push({
          event: "KEY_REMOVED",
          locker,
          tagId: previousItem?.tagId || null,
          itemName: previousItem?.itemName || null,
          itemType: previousItem?.itemType || null,
          itemKnown: typeof previousItem?.itemKnown === "boolean" ? previousItem.itemKnown : null,
          source,
          actor: deviceId,
          timestamp: now
        });
        returnObservations.push({
          locker,
          hasTag: false,
          tagId: null,
          previousTagId: previousItem?.tagId || null,
          isDoorClosed: resolvedLockerState.isDoorClosed
        });
      }

      if (existingLocker && existingLocker.hasTag === false && item.hasTag === true) {
        logWrites.push({
          event: "KEY_RETURNED",
          locker,
          tagId: nextItem?.tagId || null,
          itemName: nextItem?.itemName || null,
          itemType: nextItem?.itemType || null,
          itemKnown: typeof nextItem?.itemKnown === "boolean" ? nextItem.itemKnown : null,
          source,
          actor: deviceId,
          timestamp: now
        });
      }

      returnObservations.push({
        locker,
        hasTag: item.hasTag,
        tagId: nextItem?.tagId || null,
        previousTagId: previousItem?.tagId || null,
        isDoorClosed: resolvedLockerState.isDoorClosed
      });

      if (existingLocker && doorChanged) {
        logWrites.push({
          event: isDoorClosed ? "LOCKER_DOOR_CLOSED" : "LOCKER_DOOR_OPENED",
          locker,
          source,
          actor: deviceId,
          timestamp: now
        });
      }

      if (statusChanged || itemChanged || doorChanged) {
        lockerEvents.push(resolvedLockerState);
      }

      storedLockers.set(locker, {
        locker,
        hasTag: item.hasTag,
        tagId: item.tagId,
        doorClosed: item.doorClosed,
        lockClosed: item.lockClosed,
        version: incomingVersion,
        updatedAt: now
      });
      accepted.push({
        locker,
        accepted: true,
        version: incomingVersion,
        hasTag: resolvedLockerState.hasTag,
        isDoorClosed: resolvedLockerState.isDoorClosed,
        itemStatus: resolvedLockerState.itemStatus,
        detectedItemKnown: resolvedLockerState.detectedItemKnown,
        severity: resolvedLockerState.severity
      });
    }

    const [, logs] = await Promise.all([
      lockerWrites.length > 0
        ? Locker.bulkWrite(lockerWrites, { ordered: false })
        : Promise.resolve(),
      logWrites.length > 0
        ? Log.insertMany(logWrites)
        : Promise.resolve([]),
      DeviceState.findOneAndUpdate(
        { deviceId },
        {
          $set: {
            deviceId,
            connected: true,
            transport: context.transport || "unknown",
            connectionId: context.connectionId || this.deviceStatus.connectionId || null,
            bootId: context.bootId || payload.bootId || this.deviceStatus.bootId || null,
            lastSeenAt: now,
            lastMessageId: context.messageId || this.deviceStatus.lastMessageId || null,
            ...(context.sequence !== null && context.sequence !== undefined ? { lastSequence: context.sequence } : {}),
            lockers: [...storedLockers.values()].sort((a, b) => a.locker - b.locker)
          }
        },
        { upsert: true, returnDocument: "after" }
      )
    ]);

    for (const log of logs || []) {
      this.emit("log", log);
    }

    for (const event of lockerEvents) {
      this.emit("locker-status-changed", event);
    }

    for (const observation of returnObservations) {
      await this.processReturnLockerObservation(observation, {
        source: context.transport === "websocket" ? "device-ws" : "device-sync",
        actor: deviceId,
        deviceId
      });
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 1000) {
      console.warn("Wolne przetwarzanie state.batch urzadzenia.", {
        deviceId,
        messageId: context.messageId || null,
        elapsedMs,
        lockers: normalizedLockers.length,
        writes: lockerWrites.length,
        logs: logWrites.length
      });
    }

    this.deviceStatus = {
      ...this.deviceStatus,
      deviceId,
      connected: true,
      transport: context.transport || this.deviceStatus.transport,
      connectionId: context.connectionId || this.deviceStatus.connectionId,
      bootId: context.bootId || payload.bootId || this.deviceStatus.bootId,
      lastSeenAt: now.toISOString()
    };

    this.emit("device-status-changed", {
      status: this.getDeviceStatusSnapshot(),
      wasConnected: true
    });

    return {
      full: forceFull,
      accepted
    };
  }

  async createLog(payload) {
    const log = await Log.create({
      source: payload.source || "system",
      actor: payload.actor || null,
      ...payload,
      timestamp: payload.timestamp ?? new Date()
    });

    this.emit("log", log);
    return log;
  }

  emitRfidItemChanged(item) {
    if (!item) {
      return;
    }

    const plain = typeof item.toObject === "function" ? item.toObject() : item;
    this.emit("rfid-item-changed", plain);
  }

  emitReturnSession(eventName, session) {
    const payload = mapReturnSession(session);
    if (!payload) {
      return null;
    }

    this.emit("return-session-changed", payload);
    if (eventName) {
      this.emit(eventName, payload);
    }
    return payload;
  }

  async findActiveReturnSessionForItem(itemId) {
    return ReturnSession.findOne({
      itemId,
      status: { $in: RETURN_ACTIVE_STATUSES }
    }).sort({ startedAt: -1 });
  }

  async findActiveReturnSessionForLocker(locker) {
    return ReturnSession.findOne({
      assignedLocker: locker,
      status: { $in: RETURN_ACTIVE_STATUSES }
    }).sort({ startedAt: -1 });
  }

  async updateRfidItemState(itemId, patch = {}) {
    const updated = await RfidItem.findByIdAndUpdate(
      itemId,
      {
        $set: {
          ...patch,
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    if (updated) {
      this.emitRfidItemChanged(updated);
    }

    return updated;
  }

  async createReturnLog(event, session, context = {}, extra = {}) {
    const sessionPayload = mapReturnSession(session);
    return this.createLog({
      event,
      locker: sessionPayload?.assignedLocker || extra.locker || null,
      tagId: sessionPayload?.tagUid || extra.tagId || null,
      itemName: sessionPayload?.itemName || extra.itemName || null,
      itemKnown: true,
      source: context.source || extra.source || "return",
      actor: context.actor || extra.actor || null,
      success: extra.success,
      errorMessage: extra.errorMessage || null,
      details: {
        ...(extra.details || {}),
        sessionId: sessionPayload?.sessionId || extra.sessionId || null,
        assignedLocker: sessionPayload?.assignedLocker || extra.assignedLocker || null,
        deviceId: context.deviceId || sessionPayload?.deviceId || null,
        commandId: sessionPayload?.commandId || null
      }
    });
  }

  async startReturnByMasterScan(tagId, context = {}) {
    const normalizedTagId = assertValidTagId(tagId);
    await this.expireReturnSessions({ source: "system", actor: "return-expirer" });

    await this.createLog({
      event: "RETURN_MASTER_SCAN",
      tagId: normalizedTagId,
      source: context.source || "master-rfid",
      actor: context.actor || null,
      details: {
        sourceReader: context.sourceReader || "master-rfid"
      }
    });

    const item = await RfidItem.findOne({ tagId: normalizedTagId, active: true });
    if (!item) {
      await this.createLog({
        event: "RETURN_UNKNOWN_UID",
        tagId: normalizedTagId,
        source: context.source || "master-rfid",
        actor: context.actor || null,
        success: false,
        errorMessage: "Nieznany UID na master RFID."
      });
      throw createHttpError(404, "Nieznany UID RFID. Nie można rozpocząć zwrotu.");
    }

    if (isMasterRfidItemType(item.itemType)) {
      throw createHttpError(409, "Tag administracyjny RFID nie jest przedmiotem do zwrotu.");
    }

    const assignedLocker = normalizeAssignedLocker(item.assignedLocker);
    if (!assignedLocker) {
      item.status = "UNASSIGNED";
      item.conflictReason = "missing_assigned_locker";
      item.updatedAt = new Date();
      await item.save();
      this.emitRfidItemChanged(item);

      await this.createLog({
        event: "RETURN_NO_ASSIGNED_LOCKER",
        tagId: item.tagId,
        itemName: item.name,
        itemType: item.itemType,
        itemKnown: true,
        source: context.source || "master-rfid",
        actor: context.actor || null,
        success: false,
        errorMessage: "Przedmiot nie ma przypisanej skrytki."
      });
      throw createHttpError(409, "Przedmiot nie ma przypisanej skrytki.");
    }

    if (item.status === "IN_LOCKER") {
      await this.createLog({
        event: "RETURN_ITEM_ALREADY_IN_LOCKER",
        locker: assignedLocker,
        tagId: item.tagId,
        itemName: item.name,
        itemType: item.itemType,
        itemKnown: true,
        source: context.source || "master-rfid",
        actor: context.actor || null,
        success: false,
        details: {
          assignedLocker,
          status: item.status
        }
      });
      throw createHttpError(409, "Ten przedmiot według systemu jest już w przypisanej skrytce.");
    }

    if (!isReturnEligibleItem(item)) {
      await this.createLog({
        event: "RETURN_FAILED",
        locker: assignedLocker,
        tagId: item.tagId,
        itemName: item.name,
        itemType: item.itemType,
        itemKnown: true,
        source: context.source || "master-rfid",
        actor: context.actor || null,
        success: false,
        errorMessage: `Status ${item.status || "UNKNOWN"} nie pozwala rozpocząć zwrotu.`,
        details: {
          reason: "item_status_not_returnable",
          status: item.status || "UNKNOWN",
          assignedLocker
        }
      });
      throw createHttpError(409, "Status przedmiotu nie pozwala rozpocząć zwrotu.");
    }

    return this.createReturnSession(item, assignedLocker, context);
  }

  async createReturnSession(item, assignedLocker, context = {}) {
    assertValidLocker(assignedLocker);

    const [activeForItem, activeForLocker, targetLocker] = await Promise.all([
      this.findActiveReturnSessionForItem(item._id),
      this.findActiveReturnSessionForLocker(assignedLocker),
      Locker.findOne({ locker: assignedLocker }).lean()
    ]);

    if (activeForItem) {
      throw createHttpError(409, "Ten przedmiot ma już aktywną sesję zwrotu.");
    }

    if (activeForLocker) {
      throw createHttpError(409, "Docelowa skrytka ma już aktywną sesję zwrotu.");
    }

    if (
      targetLocker?.hasTag === true &&
      targetLocker.detectedTagId &&
      targetLocker.detectedTagId !== item.tagId
    ) {
      await this.updateRfidItemState(item._id, {
        status: "CONFLICT",
        conflictReason: "target_locker_contains_other_item"
      });
      await this.createLog({
        event: "RETURN_WRONG_ITEM",
        locker: assignedLocker,
        tagId: item.tagId,
        itemName: item.name,
        itemType: item.itemType,
        itemKnown: true,
        source: context.source || "master-rfid",
        actor: context.actor || null,
        success: false,
        errorMessage: "Docelowa skrytka zawiera inny przedmiot.",
        details: {
          detectedTagId: targetLocker.detectedTagId,
          detectedItemName: targetLocker.detectedItemName || null
        }
      });
      throw createHttpError(409, "Docelowa skrytka zawiera inny przedmiot.");
    }

    const now = new Date();
    const session = await ReturnSession.create({
      sessionId: crypto.randomUUID(),
      itemId: item._id,
      itemName: item.name,
      tagUid: item.tagId,
      assignedLocker,
      status: "PENDING",
      startedAt: now,
      expiresAt: new Date(now.getTime() + RETURN_SESSION_TIMEOUT_MS),
      sourceReader: context.sourceReader || "master-rfid",
      createdBy: context.actor || null,
      deviceId: context.deviceId || null,
      diagnostics: {
        requireDoorSensor: ENABLE_DOOR_SENSORS,
        timeoutMs: RETURN_SESSION_TIMEOUT_MS,
        targetLockerSnapshot: targetLocker || null
      }
    });

    await this.updateRfidItemState(item._id, {
      status: "RETURN_PENDING",
      conflictReason: null
    });

    const action = await this.createRemoteAction("RETURN_ITEM", assignedLocker, {
      source: context.source || "master-rfid",
      actor: context.actor || null,
      idempotencyKey: `return:${session.sessionId}`,
      payload: {
        sessionId: session.sessionId,
        itemId: item._id.toString(),
        itemName: item.name,
        tagUid: item.tagId,
        expectedUid: item.tagId,
        assignedLocker,
        timeoutMs: RETURN_SESSION_TIMEOUT_MS,
        holdLockUntilCompleted: true,
        requireDoorSensor: ENABLE_DOOR_SENSORS
      }
    });

    session.commandId = action.id;
    session.status = "IN_PROGRESS";
    await session.save();

    await this.updateRfidItemState(item._id, {
      status: "RETURN_IN_PROGRESS",
      conflictReason: null
    });

    await this.createReturnLog("RETURN_STARTED", session, context, { success: true });
    await this.createReturnLog("RETURN_LOCKER_OPENED", session, context, { success: true });
    if (ENABLE_DOOR_SENSORS) {
      await this.createReturnLog("RETURN_LOCK_HELD", session, context, { success: true });
    }

    this.emitReturnSession("return.started", session);
    this.emitReturnSession("return.in_progress", session);

    return mapReturnSession(session);
  }

  async handleReturnProgress(payload = {}, context = {}) {
    const sessionId = normalizeString(payload.sessionId);
    if (!sessionId) {
      throw createHttpError(400, "Brak sessionId sesji zwrotu.");
    }

    const session = await ReturnSession.findOne({ sessionId });
    if (!session) {
      throw createHttpError(404, "Nie znaleziono sesji zwrotu.");
    }

    if (!isActiveReturnStatus(session.status)) {
      return mapReturnSession(session);
    }

    const event = normalizeString(payload.event, "progress");
    const locker = payload.locker == null ? session.assignedLocker : assertValidLocker(Number(payload.locker));
    const uid = payload.uid || payload.tagUid || payload.detectedUid;
    const normalizedUid = uid ? assertValidTagId(uid) : null;
    const doorClosed = typeof payload.doorClosed === "boolean" ? payload.doorClosed : null;
    const now = new Date();

    session.deviceId = context.deviceId || session.deviceId || null;
    session.diagnostics = {
      ...(session.diagnostics || {}),
      lastProgress: {
        event,
        locker,
        uid: normalizedUid,
        doorClosed,
        at: now.toISOString(),
        source: context.source || "device"
      }
    };

    if (locker !== session.assignedLocker) {
      return this.failReturnSession(session.sessionId, "wrong_locker", {
        ...context,
        locker,
        detectedUid: normalizedUid
      });
    }

    if (event === "door_opened") {
      session.doorOpenedAt = session.doorOpenedAt || now;
      await session.save();
      await this.createReturnLog("RETURN_DOOR_OPENED", session, context, { success: true });
      this.emitReturnSession("return.door_opened", session);
      return mapReturnSession(session);
    }

    if (doorClosed === true) {
      session.doorClosedAt = session.doorClosedAt || now;
      session.doorClosed = true;
      await this.createReturnLog("RETURN_DOOR_CLOSED", session, context, { success: true });
      this.emitReturnSession("return.door_closed", session);
    } else if (doorClosed === false) {
      session.doorClosed = false;
    }

    if (normalizedUid) {
      session.detectedUid = normalizedUid;
      session.detectedLocker = locker;
      session.rfidDetectedAt = session.rfidDetectedAt || now;
      await this.createReturnLog("RETURN_ITEM_DETECTED", session, context, {
        success: normalizedUid === session.tagUid,
        errorMessage: normalizedUid === session.tagUid ? null : "Wykryto niewłaściwy przedmiot.",
        details: {
          detectedUid: normalizedUid
        }
      });
      this.emitReturnSession("return.item_detected", session);

      if (normalizedUid !== session.tagUid) {
        await session.save();
        return this.failReturnSession(session.sessionId, "wrong_item", {
          ...context,
          detectedUid: normalizedUid,
          locker
        });
      }
    }

    await session.save();

    if (event === "failed" || event === "timeout") {
      return this.failReturnSession(session.sessionId, payload.reason || event, context);
    }

    const hasExpectedItem = session.detectedUid === session.tagUid;
    const hasDoorCondition = ENABLE_DOOR_SENSORS ? session.doorClosed === true : true;
    if (hasExpectedItem && hasDoorCondition) {
      return this.completeReturnSession(session.sessionId, {
        locker,
        detectedUid: session.detectedUid,
        doorClosed: session.doorClosed === true,
        rfidOnly: !ENABLE_DOOR_SENSORS
      }, context);
    }

    return mapReturnSession(session);
  }

  async completeReturnSession(sessionId, payload = {}, context = {}) {
    const session = await ReturnSession.findOne({ sessionId });
    if (!session) {
      throw createHttpError(404, "Nie znaleziono sesji zwrotu.");
    }

    if (!isActiveReturnStatus(session.status)) {
      return mapReturnSession(session);
    }

    const locker = payload.locker == null ? session.assignedLocker : assertValidLocker(Number(payload.locker));
    const detectedUid = payload.detectedUid ? assertValidTagId(payload.detectedUid) : session.detectedUid;
    const doorClosed = typeof payload.doorClosed === "boolean" ? payload.doorClosed : session.doorClosed;

    if (locker !== session.assignedLocker) {
      return this.failReturnSession(session.sessionId, "wrong_locker", context);
    }

    if (detectedUid !== session.tagUid) {
      return this.failReturnSession(session.sessionId, "wrong_item", context);
    }

    if (ENABLE_DOOR_SENSORS && doorClosed !== true) {
      await session.save();
      return mapReturnSession(session);
    }

    const now = new Date();
    session.status = "COMPLETED";
    session.completedAt = now;
    session.rfidDetectedAt = session.rfidDetectedAt || now;
    session.doorClosedAt = doorClosed ? (session.doorClosedAt || now) : session.doorClosedAt;
    session.detectedUid = detectedUid;
    session.detectedLocker = locker;
    session.doorClosed = doorClosed === true;
    session.rfidOnly = payload.rfidOnly === true || !ENABLE_DOOR_SENSORS;
    await session.save();

    await this.updateRfidItemState(session.itemId, {
      status: "IN_LOCKER",
      currentLocker: session.assignedLocker,
      lastDetectedAt: now,
      conflictReason: null
    });

    await this.createReturnLog("RETURN_COMPLETED", session, context, {
      success: true,
      details: {
        rfidOnly: session.rfidOnly
      }
    });
    await this.createReturnLog("RETURN_LOCK_RELEASED", session, context, { success: true });

    this.emitReturnSession("return.completed", session);
    return mapReturnSession(session);
  }

  async failReturnSession(sessionId, reason = "failed", context = {}) {
    const session = await ReturnSession.findOne({ sessionId });
    if (!session) {
      throw createHttpError(404, "Nie znaleziono sesji zwrotu.");
    }

    if (!isActiveReturnStatus(session.status)) {
      return mapReturnSession(session);
    }

    const normalizedReason = normalizeString(reason, "failed").slice(0, 120);
    const isExpired = normalizedReason === "timeout" || normalizedReason === "expired";
    const isCancelled = normalizedReason === "manual_cancel" || normalizedReason === "cancelled";
    session.status = isExpired ? "EXPIRED" : (isCancelled ? "CANCELLED" : "FAILED");
    session.failedAt = new Date();
    session.failureReason = normalizedReason;
    session.diagnostics = {
      ...(session.diagnostics || {}),
      failureContext: {
        locker: context.locker || null,
        detectedUid: context.detectedUid || null,
        source: context.source || null,
        at: session.failedAt.toISOString()
      }
    };
    await session.save();

    const conflictFailureReasons = ["wrong_item", "wrong_locker", "target_locker_contains_other_item"];
    const nextItemStatus = conflictFailureReasons.includes(normalizedReason)
      ? "CONFLICT"
      : "RETURN_PENDING";
    await this.updateRfidItemState(session.itemId, {
      status: nextItemStatus,
      conflictReason: normalizedReason
    });

    const event = isExpired ? "RETURN_EXPIRED" : (isCancelled ? "RETURN_CANCELLED" : "RETURN_FAILED");
    await this.createReturnLog(event, session, context, {
      success: false,
      errorMessage: normalizedReason,
      details: {
        reason: normalizedReason
      }
    });
    await this.createReturnLog("RETURN_LOCK_RELEASED", session, context, {
      success: false,
      errorMessage: normalizedReason
    });

    if (["wrong_item", "wrong_locker"].includes(normalizedReason)) {
      await this.createReturnLog(
        normalizedReason === "wrong_locker" ? "RETURN_WRONG_LOCKER" : "RETURN_WRONG_ITEM",
        session,
        context,
        {
          success: false,
          errorMessage: normalizedReason,
          details: {
            detectedUid: context.detectedUid || null,
            locker: context.locker || null
          }
        }
      );
    }

    await this.createRemoteAction("CANCEL_RETURN_ITEM", session.assignedLocker, {
      source: context.source || "return",
      actor: context.actor || null,
      idempotencyKey: `return-cancel:${session.sessionId}:${session.status}`,
      payload: {
        sessionId: session.sessionId,
        reason: normalizedReason
      }
    }).catch(error => {
      console.error("Nie udalo sie zakolejkowac anulowania zwrotu.", {
        sessionId: session.sessionId,
        error: error.message
      });
    });

    this.emitReturnSession(isExpired ? "return.expired" : "return.failed", session);
    return mapReturnSession(session);
  }

  async cancelReturnSession(sessionId, context = {}) {
    return this.failReturnSession(sessionId, context.reason || "manual_cancel", {
      ...context,
      source: context.source || "web"
    });
  }

  async expireReturnSessions(context = {}) {
    const sessions = await ReturnSession.find({
      status: { $in: RETURN_ACTIVE_STATUSES },
      expiresAt: { $lte: new Date() }
    });

    const expired = [];
    for (const session of sessions) {
      expired.push(await this.failReturnSession(session.sessionId, "expired", context));
    }

    return expired;
  }

  async getReturnSessions(filters = {}) {
    await this.expireReturnSessions({ source: "system", actor: "return-expirer" });
    const status = normalizeString(filters.status).toUpperCase();
    const query = {};

    if (status === "ACTIVE") {
      query.status = { $in: RETURN_ACTIVE_STATUSES };
    } else if (status === "HISTORY") {
      query.status = { $in: RETURN_COMPLETION_STATUSES };
    } else if (RETURN_SESSION_STATUSES.includes(status)) {
      query.status = status;
    }

    const limit = Math.max(1, Math.min(Number(filters.limit) || 80, 200));
    const sessions = await ReturnSession.find(query)
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();

    return sessions.map(mapReturnSession);
  }

  async getReturnDashboardSummary() {
    await this.expireReturnSessions({ source: "system", actor: "return-expirer" });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [active, completedToday, failedToday, conflicts] = await Promise.all([
      ReturnSession.countDocuments({ status: { $in: RETURN_ACTIVE_STATUSES } }),
      ReturnSession.countDocuments({ status: "COMPLETED", completedAt: { $gte: startOfDay } }),
      ReturnSession.countDocuments({ status: { $in: ["FAILED", "EXPIRED", "CANCELLED"] }, failedAt: { $gte: startOfDay } }),
      RfidItem.countDocuments({ status: "CONFLICT", active: true })
    ]);

    return {
      active,
      completedToday,
      failedToday,
      conflicts
    };
  }

  async processReturnLockerObservation(observation = {}, context = {}) {
    const locker = assertValidLocker(Number(observation.locker));
    const tagId = observation.tagId ? assertValidTagId(observation.tagId) : null;
    const hasTag = observation.hasTag === true;
    const doorClosed = typeof observation.isDoorClosed === "boolean" ? observation.isDoorClosed : null;

    if (!hasTag || !tagId) {
      if (observation.previousTagId) {
        const previousItem = await RfidItem.findOne({ tagId: observation.previousTagId, active: true });
        if (previousItem && !isMasterRfidItemType(previousItem.itemType) && previousItem.assignedLocker === locker) {
          await this.updateRfidItemState(previousItem._id, {
            status: "CHECKED_OUT",
            currentLocker: null,
            conflictReason: null
          });
        }
      }
      return null;
    }

    const item = await RfidItem.findOne({ tagId, active: true });
    const activeSession = await this.findActiveReturnSessionForLocker(locker);

    if (activeSession) {
      return this.handleReturnProgress({
        sessionId: activeSession.sessionId,
        locker,
        event: "item_detected",
        uid: tagId,
        doorClosed
      }, context);
    }

    if (!item || isMasterRfidItemType(item.itemType)) {
      return null;
    }

    const assignedLocker = normalizeAssignedLocker(item.assignedLocker);
    if (!assignedLocker) {
      await this.updateRfidItemState(item._id, {
        status: "UNASSIGNED",
        currentLocker: locker,
        lastDetectedAt: new Date(),
        conflictReason: "detected_without_assigned_locker"
      });
      return null;
    }

    if (assignedLocker !== locker) {
      await this.updateRfidItemState(item._id, {
        status: "CONFLICT",
        currentLocker: locker,
        lastDetectedAt: new Date(),
        conflictReason: "detected_in_wrong_locker"
      });
      await this.createLog({
        event: "RETURN_WRONG_LOCKER",
        locker,
        tagId: item.tagId,
        itemName: item.name,
        itemType: item.itemType,
        itemKnown: true,
        source: context.source || "device",
        actor: context.actor || null,
        success: false,
        errorMessage: "Przedmiot wykryto w niewłaściwej skrytce.",
        details: {
          assignedLocker
        }
      });
      return null;
    }

    if (!RETURN_ITEM_ACTIVE_STATUSES.includes(item.status)) {
      await this.updateRfidItemState(item._id, {
        status: "IN_LOCKER",
        currentLocker: locker,
        lastDetectedAt: new Date(),
        conflictReason: null
      });
    }

    return null;
  }

  async findRfidItemByTagId(tagId) {
    if (!tagId) {
      return null;
    }

    return RfidItem.findOne({
      tagId: assertValidTagId(tagId),
      active: true
    }).lean();
  }

  async describeDetectedItem(tagId) {
    if (!tagId) {
      return {
        tagId: null,
        itemName: null,
        itemType: null,
        itemKnown: null
      };
    }

    const normalizedTagId = assertValidTagId(tagId);
    const item = await this.findRfidItemByTagId(normalizedTagId);

    if (!item) {
      return {
        tagId: normalizedTagId,
        itemName: null,
        itemType: null,
        itemKnown: false
      };
    }

    return {
      tagId: item.tagId,
      itemName: item.name,
      itemType: item.itemType,
      itemKnown: true
    };
  }

  async resolveRfidAccess(tagId) {
    const normalizedTagId = assertValidTagId(tagId);
    const user = await RfidUser.findOne({ tagId: normalizedTagId, active: true }).lean();
    const item = await this.describeDetectedItem(normalizedTagId);

    if (!user && item.itemKnown && isMasterRfidItemType(item.itemType)) {
      return {
        valid: true,
        isMaster: true,
        item,
        user: {
          id: null,
          name: item.itemName || "Master RFID",
          tagId: item.tagId,
          role: "rfid-master"
        },
        allowedLockers: [...ALLOWED_LOCKERS]
      };
    }

    if (!user) {
      return {
        valid: false,
        isMaster: false,
        item,
        user: null,
        allowedLockers: []
      };
    }

    return {
      valid: true,
      isMaster: false,
      item,
      user: {
        id: user._id.toString(),
        name: user.name,
        tagId: user.tagId
      },
      allowedLockers: [...user.allowedLockers]
    };
  }

  async generateUniqueCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      const existing = await Code.exists({ code, active: true, expiresAt: { $gt: new Date() } });

      if (!existing) {
        return code;
      }
    }

    throw createHttpError(503, "Nie udało się wygenerować unikalnego kodu. Spróbuj ponownie.");
  }

  async verifyCode(code, context = {}) {
    assertValidCode(code);
    const found = await Code.findOne({ code, active: true });

    if (!found || new Date() > found.expiresAt) {
      await this.createLog({
        event: "INVALID_CODE",
        code,
        success: false,
        details: {
          reason: "code_not_found_or_inactive"
        },
        source: context.source || "device",
        actor: context.actor || null
      });

      return { valid: false };
    }

    found.active = false;
    await found.save();
    this.emit("active-codes-changed");

    await this.createLog({
      event: "LOCKER_OPENED",
      code,
      locker: found.locker,
      success: true,
      recipientEmail: found.recipientEmail || null,
      source: context.source || "device",
      actor: context.actor || null
    });

    return {
      valid: true,
      locker: found.locker
    };
  }

  async deliverCodeByEmail(codeRecord, context = {}) {
    const recipientEmail = codeRecord.recipientEmail;
    const attemptedResponse = {
      attempted: true,
      sent: false,
      recipientEmail,
      sentAt: null,
      error: null
    };

    if (!recipientEmail) {
      return {
        attempted: false,
        sent: false,
        recipientEmail: null,
        sentAt: null,
        error: null
      };
    }

    if (!this.emailService || !this.emailService.isEnabled()) {
      const errorMessage = "Wysylka e-mail nie jest skonfigurowana na serwerze.";

      codeRecord.emailDeliveryAttempted = true;
      codeRecord.emailDeliveryError = errorMessage;
      await codeRecord.save();

      await this.createLog({
        event: "CODE_EMAIL_FAILED",
        code: codeRecord.code,
        locker: codeRecord.locker,
        recipientEmail,
        errorMessage,
        details: {
          reason: "email_service_disabled",
          expiresAt: codeRecord.expiresAt
        },
        source: context.source || "web",
        actor: context.actor || null
      });

      return {
        ...attemptedResponse,
        error: errorMessage
      };
    }

    try {
      await this.emailService.sendGeneratedCodeEmail({
        to: recipientEmail,
        code: codeRecord.code,
        locker: codeRecord.locker,
        expiresAt: codeRecord.expiresAt,
        requestedBy: context.actor || null
      });

      codeRecord.emailDeliveryAttempted = true;
      codeRecord.emailSentAt = new Date();
      codeRecord.emailDeliveryError = null;
      await codeRecord.save();

      await this.createLog({
        event: "CODE_EMAIL_SENT",
        code: codeRecord.code,
        locker: codeRecord.locker,
        recipientEmail,
        details: {
          sentAt: codeRecord.emailSentAt,
          expiresAt: codeRecord.expiresAt
        },
        source: context.source || "web",
        actor: context.actor || null
      });

      return {
        ...attemptedResponse,
        sent: true,
        sentAt: codeRecord.emailSentAt
      };
    } catch (error) {
      const errorMessage = normalizeEmailError(error);

      console.error("Nie udalo sie wyslac e-maila z kodem SafeKeys.", {
        locker: codeRecord.locker,
        code: codeRecord.code,
        recipientEmail,
        source: context.source || "web",
        actor: context.actor || null,
        errorMessage: error.message,
        errorCode: error.code || null,
        errorResponse: error.response || null,
        errorCommand: error.command || null,
        emailProvider: error.emailProvider || null,
        apiEndpoint: error.apiEndpoint || null,
        responseStatus: error.responseStatus || null,
        responseBody: error.responseBody || null,
        smtpHost: error.smtpHost || null,
        smtpPort: error.smtpPort || null,
        smtpSecure: error.smtpSecure ?? null
      });

      codeRecord.emailDeliveryAttempted = true;
      codeRecord.emailDeliveryError = errorMessage;
      await codeRecord.save();

      await this.createLog({
        event: "CODE_EMAIL_FAILED",
        code: codeRecord.code,
        locker: codeRecord.locker,
        recipientEmail,
        errorMessage,
        details: {
          reason: "email_send_failed",
          expiresAt: codeRecord.expiresAt
        },
        source: context.source || "web",
        actor: context.actor || null
      });

      return {
        ...attemptedResponse,
        error: errorMessage
      };
    }
  }

  async generateCode(lockerOrPayload, hoursOrContext, maybeContext = {}) {
    const { locker, hours, recipientEmail } = parseGenerateCodeInput(lockerOrPayload, hoursOrContext);
    const context = typeof lockerOrPayload === "object" && lockerOrPayload !== null
      ? (hoursOrContext || {})
      : maybeContext;

    assertValidLocker(locker);
    assertValidHours(hours);

    const code = await this.generateUniqueCode();
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    const codeRecord = await Code.create({
      code,
      locker,
      active: true,
      expiresAt,
      recipientEmail
    });
    this.emit("active-codes-changed");

    await this.createLog({
      event: "CODE_GENERATED",
      code,
      locker,
      recipientEmail,
      details: {
        hours,
        expiresAt
      },
      source: context.source || "web",
      actor: context.actor || null
    });

    const emailDelivery = await this.deliverCodeByEmail(codeRecord, context);

    return {
      code,
      locker,
      hours,
      expiresAt,
      recipientEmail,
      emailDelivery
    };
  }

  async deactivateCode(code, context = {}) {
    assertValidCode(code);

    const found = await Code.findOne({ code, active: true });
    if (!found) {
      throw createHttpError(404, "Nie znaleziono aktywnego kodu.");
    }

    found.active = false;
    await found.save();
    this.emit("active-codes-changed");

    await this.createLog({
      event: "CODE_DEACTIVATED",
      code,
      locker: found.locker,
      recipientEmail: found.recipientEmail || null,
      details: {
        expiresAt: found.expiresAt
      },
      source: context.source || "web",
      actor: context.actor || null
    });

    return { success: true };
  }

  async getLockers() {
    const data = await Locker.find();

    return ALLOWED_LOCKERS.map(num => {
      const found = data.find(item => item.locker === num);
      return buildLockerStatePayload({
        locker: num,
        hasTag: found ? found.hasTag : false,
        isDoorClosed: found ? found.isDoorClosed !== false : true,
        detectedTagId: found?.detectedTagId || null,
        detectedItemName: found?.detectedItemName || null,
        detectedItemType: found?.detectedItemType || null,
        detectedItemKnown: typeof found?.detectedItemKnown === "boolean" ? found.detectedItemKnown : null,
        detectedAt: found?.detectedAt || null
      });
    });
  }

  async updateLockerStatus(locker, hasTag, context = {}) {
    assertValidLocker(locker);
    assertValidHasTag(hasTag);

    let found = await Locker.findOne({ locker });
    const prev = found ? found.hasTag : null;
    const previousItem = found
      ? {
          tagId: found.detectedTagId || null,
          itemName: found.detectedItemName || null,
          itemType: found.detectedItemType || null,
          itemKnown: typeof found.detectedItemKnown === "boolean" ? found.detectedItemKnown : null
        }
      : null;
    const nextItem = hasTag
      ? (context.tagId ? await this.describeDetectedItem(context.tagId) : previousItem)
      : {
          tagId: null,
          itemName: null,
          itemType: null,
          itemKnown: null
        };
    const itemChanged = previousItem?.tagId !== nextItem?.tagId
      || previousItem?.itemName !== nextItem?.itemName
      || previousItem?.itemType !== nextItem?.itemType
      || previousItem?.itemKnown !== nextItem?.itemKnown;
    const statusChanged = prev !== hasTag;

    if (found && !statusChanged && !itemChanged) {
      return { success: true, unchanged: true };
    }

    if (!found) {
      found = await Locker.create({
        locker,
        hasTag,
        detectedTagId: nextItem?.tagId || null,
        detectedItemName: nextItem?.itemName || null,
        detectedItemType: nextItem?.itemType || null,
        detectedItemKnown: typeof nextItem?.itemKnown === "boolean" ? nextItem.itemKnown : null,
        detectedAt: hasTag ? new Date() : null
      });
    } else {
      found.hasTag = hasTag;
      found.detectedTagId = nextItem?.tagId || null;
      found.detectedItemName = nextItem?.itemName || null;
      found.detectedItemType = nextItem?.itemType || null;
      found.detectedItemKnown = typeof nextItem?.itemKnown === "boolean" ? nextItem.itemKnown : null;
      found.detectedAt = hasTag ? new Date() : null;
      await found.save();
    }

    if (prev !== null && prev === true && hasTag === false) {
      await this.createLog({
        event: "KEY_REMOVED",
        locker,
        tagId: previousItem?.tagId || null,
        itemName: previousItem?.itemName || null,
        itemType: previousItem?.itemType || null,
        itemKnown: typeof previousItem?.itemKnown === "boolean" ? previousItem.itemKnown : null,
        source: context.source || "rfid",
        actor: context.actor || null
      });
    }

    if (prev !== null && prev === false && hasTag === true) {
      await this.createLog({
        event: "KEY_RETURNED",
        locker,
        tagId: nextItem?.tagId || null,
        itemName: nextItem?.itemName || null,
        itemType: nextItem?.itemType || null,
        itemKnown: typeof nextItem?.itemKnown === "boolean" ? nextItem.itemKnown : null,
        source: context.source || "rfid",
        actor: context.actor || null
      });
    }

    this.emit("locker-status-changed", buildLockerStatePayload({
      locker,
      hasTag,
      isDoorClosed: found.isDoorClosed !== false,
      detectedTagId: nextItem?.tagId || null,
      detectedItemName: nextItem?.itemName || null,
      detectedItemType: nextItem?.itemType || null,
      detectedItemKnown: typeof nextItem?.itemKnown === "boolean" ? nextItem.itemKnown : null,
      detectedAt: found.detectedAt || null,
      source: context.source || "rfid"
    }));

    await this.processReturnLockerObservation({
      locker,
      hasTag,
      tagId: nextItem?.tagId || null,
      previousTagId: previousItem?.tagId || null,
      isDoorClosed: found.isDoorClosed !== false
    }, {
      source: context.source || "rfid",
      actor: context.actor || null
    });

    return { success: true };
  }

  async updateLockerDoorStatus(locker, isDoorClosed, context = {}) {
    assertValidLocker(locker);
    assertValidDoorClosed(isDoorClosed);

    let found = await Locker.findOne({ locker });
    const prev = found ? found.isDoorClosed !== false : null;

    if (found && prev === isDoorClosed) {
      return { success: true, unchanged: true };
    }

    if (!found) {
      found = await Locker.create({ locker, hasTag: false, isDoorClosed });
    } else {
      found.isDoorClosed = isDoorClosed;
      await found.save();
    }

    if (prev !== null && prev !== isDoorClosed) {
      await this.createLog({
        event: isDoorClosed ? "LOCKER_DOOR_CLOSED" : "LOCKER_DOOR_OPENED",
        locker,
        source: context.source || "contactron",
        actor: context.actor || null
      });
    }

    this.emit("locker-status-changed", buildLockerStatePayload({
      locker,
      hasTag: found.hasTag === true,
      isDoorClosed,
      detectedTagId: found.detectedTagId || null,
      detectedItemName: found.detectedItemName || null,
      detectedItemType: found.detectedItemType || null,
      detectedItemKnown: typeof found.detectedItemKnown === "boolean" ? found.detectedItemKnown : null,
      detectedAt: found.detectedAt || null,
      source: context.source || "contactron"
    }));

    await this.processReturnLockerObservation({
      locker,
      hasTag: found.hasTag === true,
      tagId: found.detectedTagId || null,
      isDoorClosed
    }, {
      source: context.source || "contactron",
      actor: context.actor || null
    });

    return { success: true };
  }

  async createRemoteAction(type, locker, context = {}) {
    const payload = {
      type,
      locker: locker ?? null,
      source: context.source || "web",
      actor: context.actor || null,
      payload: context.payload || null
    };

    if (context.idempotencyKey) {
      payload.idempotencyKey = String(context.idempotencyKey).trim();
    }

    const command = payload.idempotencyKey
      ? await DeviceCommand.findOneAndUpdate(
          { idempotencyKey: payload.idempotencyKey },
          { $setOnInsert: payload },
          { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
        )
      : await DeviceCommand.create(payload);
    const action = mapCommandForHistory(command);

    this.flushRemoteActionWaiters().catch(error => {
      console.error("Nie udalo sie przekazac oczekujacych polecen urzadzenia.", error);
    });
    this.emit("remote-action-queued", action);
    return action;
  }

  async openLocker(locker, context = {}) {
    assertValidLocker(locker);

    const action = await this.createRemoteAction("OPEN_LOCKER", locker, context);
    await this.createLog({
      event: "REMOTE_UNLOCK_REQUESTED",
      locker,
      details: {
        actionId: action.id
      },
      source: context.source || "web",
      actor: context.actor || null
    });

    return {
      success: true,
      actionId: action.id,
      locker
    };
  }

  async openMultipleLockers(lockers = [], context = {}) {
    const normalizedLockers = [...new Set(lockers.map(locker => Number(locker)))];
    if (normalizedLockers.length === 0) {
      return [];
    }

    const actions = [];
    for (const locker of normalizedLockers) {
      actions.push(await this.openLocker(locker, context));
    }
    return actions;
  }

  async releaseAllLockers(context = {}) {
    const action = await this.createRemoteAction("RELEASE_ALL_LOCKERS", null, context);
    await this.createLog({
      event: "REMOTE_RELEASE_ALL_REQUESTED",
      details: {
        actionId: action.id
      },
      source: context.source || "web",
      actor: context.actor || null
    });

    return {
      success: true,
      actionId: action.id
    };
  }

  async consumeRemoteActions(context = {}) {
    return this.deliverPendingRemoteActions({
      ...context,
      transport: context.transport || "https-poll",
      forceRedelivery: context.forceRedelivery === true
    });
  }

  async deliverPendingRemoteActions(context = {}) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - DEVICE_COMMAND_REDELIVER_AFTER_MS);
    const statusFilter = context.forceRedelivery
      ? { status: { $in: COMMAND_DELIVERABLE_STATUSES } }
      : {
          $or: [
            { status: "pending" },
            {
              status: "delivered",
              $or: [
                { lastDeliveryAt: null },
                { lastDeliveryAt: { $lte: staleBefore } }
              ]
            }
          ]
        };
    const commands = await DeviceCommand.find(statusFilter)
      .sort({ createdAt: 1 })
      .limit(Math.max(1, Math.min(Number(context.limit) || DEVICE_COMMAND_DELIVERY_LIMIT, 50)));

    if (commands.length === 0) {
      return [];
    }

    await this.markRemoteActionsDelivered(commands, {
      transport: context.transport || "unknown",
      deviceId: normalizeDeviceId(context.deviceId)
    });

    return commands.map(mapCommandForDevice);
  }

  async markRemoteActionsDelivered(actions, context = {}) {
    const sentAt = new Date();
    const ids = actions.map(action => action._id || action.id).filter(Boolean);
    if (ids.length === 0) {
      return;
    }

    await DeviceCommand.updateMany(
      {
        _id: { $in: ids },
        status: { $in: COMMAND_DELIVERABLE_STATUSES }
      },
      {
        $set: {
          status: "delivered",
          deliveredAt: sentAt,
          lastDeliveryAt: sentAt
        },
        $inc: {
          deliveryCount: 1
        },
        $push: {
          deliveries: {
            at: sentAt,
            transport: context.transport || "unknown",
            deviceId: context.deviceId || DEFAULT_DEVICE_ID
          }
        }
      }
    );

    actions.forEach(action => {
      this.emit("remote-action-updated", {
        ...mapCommandForHistory(action),
        status: "delivered",
        deliveredAt: sentAt,
        lastDeliveryAt: sentAt,
        deliveryCount: (action.deliveryCount || 0) + 1
      });
    });
  }

  async acknowledgeRemoteAction(actionId, payload = {}, context = {}) {
    const command = await DeviceCommand.findById(actionId);
    if (!command) {
      throw createHttpError(404, "Nie znaleziono akcji urzadzenia.");
    }

    if (COMMAND_TERMINAL_STATUSES.has(command.status)) {
      return mapCommandForHistory(command);
    }

    const ack = normalizeCommandAckPayload({
      ...payload,
      commandId: actionId
    });
    const now = new Date();
    const nextStatus = ack.success
      ? (ack.status === "acknowledged" ? "acknowledged" : "applied")
      : "failed";

    command.status = nextStatus;
    command.acknowledgedAt = command.acknowledgedAt || now;
    if (nextStatus === "applied") {
      command.appliedAt = now;
    }
    if (nextStatus === "failed") {
      command.failedAt = now;
    }
    command.result = {
      success: ack.success,
      message: typeof payload.message === "string" ? payload.message.slice(0, 240) : null,
      source: context.source || "device",
      transport: context.transport || null,
      deviceId: normalizeDeviceId(context.deviceId)
    };
    await command.save();

    const action = mapCommandForHistory(command);
    this.emit("remote-action-updated", action);

    if (nextStatus === "failed" && command.type === "RETURN_ITEM") {
      const session = await ReturnSession.findOne({
        commandId: command._id.toString(),
        status: { $in: RETURN_ACTIVE_STATUSES }
      });
      if (session) {
        await this.failReturnSession(session.sessionId, "device_command_failed", {
          source: context.source || "device",
          actor: normalizeDeviceId(context.deviceId),
          deviceId: normalizeDeviceId(context.deviceId)
        });
      }
    }

    return action;
  }

  async getRemoteActionHistory(limit = 50) {
    const commands = await DeviceCommand.find()
      .sort({ createdAt: -1 })
      .limit(Math.max(1, Math.min(Number(limit) || 50, 200)))
      .lean();

    return commands.map(mapCommandForHistory);
  }

  async flushRemoteActionWaiters() {
    if (this.pendingRemoteActionWaiters.length === 0) {
      return;
    }

    const actions = await this.consumeRemoteActions({ forceRedelivery: true });
    const waiters = [...this.pendingRemoteActionWaiters];
    this.pendingRemoteActionWaiters = [];

    waiters.forEach(waiter => {
      clearTimeout(waiter.timeoutId);
      waiter.resolve(actions);
    });
  }

  async waitForRemoteActions(timeoutMs = 0) {
    const readyActions = await this.consumeRemoteActions();
    if (readyActions.length > 0) {
      return readyActions;
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return [];
    }

    return new Promise(resolve => {
      const waiter = {
        resolve,
        timeoutId: setTimeout(() => {
          this.pendingRemoteActionWaiters = this.pendingRemoteActionWaiters.filter(candidate => candidate !== waiter);
          resolve([]);
        }, timeoutMs)
      };

      this.pendingRemoteActionWaiters.push(waiter);
    });
  }

  generateRandomTagId() {
    return crypto.randomBytes(5).toString("hex").toUpperCase();
  }

  async getActiveCodes() {
    const now = new Date();

    await Code.updateMany(
      { active: true, expiresAt: { $lte: now } },
      { $set: { active: false } }
    );

    return Code.find({
      active: true,
      expiresAt: { $gt: now }
    }).sort({ expiresAt: 1 });
  }

  async getLogs(filters = {}) {
    const query = {};
    const limit = Math.max(1, Math.min(Number(filters.limit) || 80, 500));

    if (filters.event) {
      query.event = String(filters.event).trim();
    }

    if (filters.locker) {
      const locker = Number(filters.locker);
      if (Number.isInteger(locker)) {
        query.locker = locker;
      }
    }

    if (filters.from || filters.to) {
      query.timestamp = {};
      if (filters.from) {
        query.timestamp.$gte = new Date(filters.from);
      }
      if (filters.to) {
        query.timestamp.$lte = new Date(filters.to);
      }
    }

    if (filters.q) {
      const q = String(filters.q).trim().slice(0, 80);
      if (q) {
        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        query.$or = [
          { code: regex },
          { tagId: regex },
          { actor: regex },
          { itemName: regex },
          { source: regex },
          { event: regex }
        ];
      }
    }

    return Log.find(query).sort({ timestamp: -1 }).limit(limit);
  }

  async getLogEventTypes() {
    return Log.distinct("event");
  }

  async exportLogs(filters = {}) {
    const logs = await this.getLogs({ ...filters, limit: filters.limit || 500 });
    const header = ["timestamp", "event", "locker", "code", "tagId", "itemName", "recipientEmail", "errorMessage", "source", "actor", "success"];
    const rows = logs.map(log => header.map(key => {
      const value = log[key] ?? "";
      return `"${String(value).replace(/"/g, '""')}"`;
    }).join(","));

    return [header.join(","), ...rows].join("\n");
  }

  async getBackupSnapshot() {
    const [lockers, rfidUsers, rfidItems, returnSessions, activeCodes, logs, remoteActions] = await Promise.all([
      this.getLockers(),
      this.getRfidUsers(),
      this.getRfidItems(),
      this.getReturnSessions({ limit: 200 }),
      this.getActiveCodes(),
      this.getLogs({ limit: 500 }),
      this.getRemoteActionHistory()
    ]);

    return {
      exportedAt: new Date().toISOString(),
      lockers,
      rfidUsers,
      rfidItems,
      returnSessions,
      activeCodes,
      logs,
      remoteActions
    };
  }

  async getRfidUsers() {
    return RfidUser.find().sort({ name: 1 }).lean();
  }

  async getRfidItems() {
    return RfidItem.find().sort({ name: 1 }).lean();
  }

  getCurrentTagAssignment() {
    return this.currentTagAssignment
      ? { ...this.currentTagAssignment }
      : null;
  }

  async startTagAssignment(payload = {}, context = {}) {
    if (this.currentTagAssignment?.status === "pending") {
      throw createHttpError(409, "Trwa już nadawanie taga RFID. Dokończ je albo poczekaj na wynik.");
    }

    const itemName = typeof payload.itemName === "string" ? payload.itemName.trim() : "";
    const assignment = {
      id: new mongoose.Types.ObjectId().toString(),
      itemName: itemName || null,
      tagId: this.generateRandomTagId(),
      status: "pending",
      createdAt: new Date().toISOString(),
      startedBy: context.actor || "system",
      result: null
    };

    this.currentTagAssignment = assignment;
    await this.createRemoteAction("ASSIGN_RFID_TAG", null, {
      ...context,
      payload: {
        assignmentId: assignment.id,
        tagId: assignment.tagId,
        itemName: assignment.itemName
      }
    });

    await this.createLog({
      event: "RFID_TAG_ASSIGNMENT_STARTED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${assignment.itemName || "bez nazwy"} • ${assignment.tagId}`,
      tagId: assignment.tagId,
      itemName: assignment.itemName || null,
      details: {
        assignmentId: assignment.id
      }
    });

    this.emit("rfid-tag-assignment-updated", this.getCurrentTagAssignment());
    return this.getCurrentTagAssignment();
  }

  async cancelTagAssignment(context = {}) {
    if (!this.currentTagAssignment) {
      throw createHttpError(404, "Nie ma aktywnego zadania nadawania taga RFID.");
    }

    const assignment = { ...this.currentTagAssignment };
    const shouldStopDevice = assignment.status === "pending";

    if (shouldStopDevice) {
      await this.createRemoteAction("CANCEL_RFID_TAG_ASSIGNMENT", null, {
        ...context,
        payload: {
          assignmentId: assignment.id
        }
      });
    }

    await this.createLog({
      event: "RFID_TAG_ASSIGNMENT_CANCELLED",
      source: context.source || "web",
      actor: context.actor || "system",
      tagId: assignment.tagId,
      itemName: assignment.itemName || null,
      details: {
        assignmentId: assignment.id,
        cancelledAt: new Date().toISOString(),
        reason: context.reason || (shouldStopDevice ? "manual_cancel" : "cleanup_after_result")
      }
    });

    this.currentTagAssignment = null;
    this.emit("rfid-tag-assignment-updated", null);

    return {
      success: true,
      cancelledAssignmentId: assignment.id
    };
  }

  async completeTagAssignment(payload = {}, context = {}) {
    if (!this.currentTagAssignment || this.currentTagAssignment.id !== payload.assignmentId) {
      throw createHttpError(404, "Nie znaleziono aktywnego zadania nadawania taga.");
    }

    const success = payload.success === true;
    const result = {
      success,
      tagId: typeof payload.tagId === "string" ? payload.tagId.trim().toUpperCase() : this.currentTagAssignment.tagId,
      physicalUid: typeof payload.physicalUid === "string" ? payload.physicalUid.trim().toUpperCase() : null,
      error: typeof payload.error === "string" ? payload.error.trim().slice(0, 240) : null,
      completedAt: new Date().toISOString(),
      source: context.source || "device"
    };

    this.currentTagAssignment = {
      ...this.currentTagAssignment,
      status: success ? "completed" : "failed",
      result
    };

    await this.createLog({
      event: success ? "RFID_TAG_ASSIGNMENT_COMPLETED" : "RFID_TAG_ASSIGNMENT_FAILED",
      source: context.source || "device",
      actor: result.physicalUid || context.actor || "device",
      tagId: result.tagId,
      errorMessage: result.error || null,
      details: {
        assignmentId: this.currentTagAssignment.id,
        physicalUid: result.physicalUid,
        completedAt: result.completedAt
      },
      itemKnown: true,
      itemName: this.currentTagAssignment.itemName || null
    });

    this.emit("rfid-tag-assignment-updated", this.getCurrentTagAssignment());
    return this.getCurrentTagAssignment();
  }

  async createRfidUser(payload, context = {}) {
    const name = assertValidUserName(payload.name);
    const tagId = assertValidTagId(payload.tagId);
    const allowedLockers = assertValidAllowedLockers(payload.allowedLockers);

    const existing = await RfidUser.findOne({ tagId });
    if (existing) {
      throw createHttpError(409, "Uzytkownik z tym tagiem RFID juz istnieje.");
    }

    const existingMasterItem = await RfidItem.findOne({ tagId, itemType: { $in: [...MASTER_RFID_ITEM_TYPES] } });
    if (existingMasterItem) {
      throw createHttpError(409, "Ten UID jest juz przypisany jako administracyjny tag RFID.");
    }

    const user = await RfidUser.create({
      name,
      tagId,
      allowedLockers,
      updatedAt: new Date()
    });

    await this.createLog({
      event: "RFID_USER_CREATED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${name} • ${tagId}`
    });

    return user.toObject();
  }

  async updateRfidUser(userId, payload, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw createHttpError(400, "Nieprawidlowe ID uzytkownika.");
    }

    const name = assertValidUserName(payload.name);
    const tagId = assertValidTagId(payload.tagId);
    const allowedLockers = assertValidAllowedLockers(payload.allowedLockers);
    const user = await RfidUser.findById(userId);

    if (!user) {
      throw createHttpError(404, "Nie znaleziono uzytkownika RFID.");
    }

    const existingWithTag = await RfidUser.findOne({ tagId, _id: { $ne: userId } });
    if (existingWithTag) {
      throw createHttpError(409, "Inny uzytkownik ma juz ten tag RFID.");
    }

    const existingMasterItem = await RfidItem.findOne({ tagId, itemType: { $in: [...MASTER_RFID_ITEM_TYPES] } });
    if (existingMasterItem) {
      throw createHttpError(409, "Ten UID jest juz przypisany jako administracyjny tag RFID.");
    }

    user.name = name;
    user.tagId = tagId;
    user.allowedLockers = allowedLockers;
    user.updatedAt = new Date();
    await user.save();

    await this.createLog({
      event: "RFID_USER_UPDATED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${name} • ${tagId}`
    });

    return user.toObject();
  }

  async deleteRfidUser(userId, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      throw createHttpError(400, "Nieprawidlowe ID uzytkownika.");
    }

    const user = await RfidUser.findById(userId);
    if (!user) {
      throw createHttpError(404, "Nie znaleziono uzytkownika RFID.");
    }

    await user.deleteOne();

    await this.createLog({
      event: "RFID_USER_DELETED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${user.name} • ${user.tagId}`
    });

    return { success: true };
  }

  async createRfidItem(payload, context = {}) {
    const name = assertValidRfidItemName(payload.name);
    const tagId = assertValidTagId(payload.tagId);
    const itemType = assertValidRfidItemType(payload.itemType);
    const itemState = normalizeRfidItemPayload(payload);

    if (isMasterRfidItemType(itemType) && context.role !== "master") {
      throw createHttpError(403, "Tylko użytkownik master może dodawać tagi administracyjne RFID.");
    }

    const existing = await RfidItem.findOne({ tagId });
    if (existing) {
      throw createHttpError(409, "Przedmiot RFID z tym tagiem juz istnieje.");
    }

    if (isMasterRfidItemType(itemType)) {
      const existingUser = await RfidUser.findOne({ tagId });
      if (existingUser) {
        throw createHttpError(409, "Ten UID jest juz przypisany jako zwykly uzytkownik RFID.");
      }
    }

    const item = await RfidItem.create({
      name,
      tagId,
      itemType,
      assignedLocker: isMasterRfidItemType(itemType) ? null : itemState.assignedLocker,
      status: isMasterRfidItemType(itemType) ? "UNKNOWN" : itemState.status,
      currentLocker: isMasterRfidItemType(itemType) ? null : itemState.currentLocker,
      conflictReason: itemState.conflictReason,
      updatedAt: new Date()
    });

    await this.createLog({
      event: "RFID_ITEM_CREATED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${name} • ${tagId}`
    });

    if (this.currentTagAssignment?.result?.tagId === tagId || this.currentTagAssignment?.tagId === tagId) {
      this.currentTagAssignment = null;
      this.emit("rfid-tag-assignment-updated", null);
    }

    this.emitRfidItemChanged(item);
    return item.toObject();
  }

  async updateRfidItem(itemId, payload, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(itemId)) {
      throw createHttpError(400, "Nieprawidlowe ID przedmiotu RFID.");
    }

    const name = assertValidRfidItemName(payload.name);
    const tagId = assertValidTagId(payload.tagId);
    const itemType = assertValidRfidItemType(payload.itemType);
    const item = await RfidItem.findById(itemId);

    if (!item) {
      throw createHttpError(404, "Nie znaleziono przedmiotu RFID.");
    }

    const existingWithTag = await RfidItem.findOne({ tagId, _id: { $ne: itemId } });
    if (existingWithTag) {
      throw createHttpError(409, "Inny przedmiot RFID ma juz ten tag.");
    }

    if ((isMasterRfidItemType(item.itemType) || isMasterRfidItemType(itemType)) && context.role !== "master") {
      throw createHttpError(403, "Tylko użytkownik master może edytować tagi administracyjne RFID.");
    }

    if (isMasterRfidItemType(itemType)) {
      const existingUser = await RfidUser.findOne({ tagId });
      if (existingUser) {
        throw createHttpError(409, "Ten UID jest juz przypisany jako zwykly uzytkownik RFID.");
      }
    }

    const previousTagId = item.tagId;
    const itemState = normalizeRfidItemPayload(payload, item);
    item.name = name;
    item.tagId = tagId;
    item.itemType = itemType;
    item.assignedLocker = isMasterRfidItemType(itemType) ? null : itemState.assignedLocker;
    item.status = isMasterRfidItemType(itemType) ? "UNKNOWN" : itemState.status;
    item.currentLocker = isMasterRfidItemType(itemType) ? null : itemState.currentLocker;
    item.conflictReason = itemState.conflictReason;
    item.updatedAt = new Date();
    await item.save();

    await Locker.updateMany(
      { detectedTagId: previousTagId },
      {
        $set: {
          detectedTagId: item.tagId,
          detectedItemName: item.name,
          detectedItemType: item.itemType,
          detectedItemKnown: true
        }
      }
    );

    await this.createLog({
      event: "RFID_ITEM_UPDATED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${name} • ${tagId}`
    });

    if (this.currentTagAssignment?.result?.tagId === tagId || this.currentTagAssignment?.tagId === tagId) {
      this.currentTagAssignment = null;
      this.emit("rfid-tag-assignment-updated", null);
    }

    this.emitRfidItemChanged(item);
    return item.toObject();
  }

  async deleteRfidItem(itemId, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(itemId)) {
      throw createHttpError(400, "Nieprawidlowe ID przedmiotu RFID.");
    }

    const item = await RfidItem.findById(itemId);
    if (!item) {
      throw createHttpError(404, "Nie znaleziono przedmiotu RFID.");
    }

    if (isMasterRfidItemType(item.itemType) && context.role !== "master") {
      throw createHttpError(403, "Tylko użytkownik master może usuwać tagi administracyjne RFID.");
    }

    await Locker.updateMany(
      { detectedTagId: item.tagId },
      {
        $set: {
          detectedItemName: null,
          detectedItemType: null,
          detectedItemKnown: false
        }
      }
    );

    await item.deleteOne();

    await this.createLog({
      event: "RFID_ITEM_DELETED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${item.name} • ${item.tagId}`
    });

    return { success: true };
  }

  async verifyRfidTag(tagId, context = {}) {
    const access = await this.resolveRfidAccess(tagId);

    if (!access.valid) {
      if (access.item?.itemKnown === true && !isMasterRfidItemType(access.item.itemType)) {
        try {
          const returnSession = await this.startReturnByMasterScan(tagId, {
            source: context.source || "master-rfid",
            actor: context.actor || null,
            sourceReader: "master-rfid"
          });

          return {
            valid: false,
            item: access.item,
            isMaster: false,
            allowedLockers: [],
            accessibleLockersMask: 0,
            returnStarted: true,
            returnSession
          };
        } catch (error) {
          return {
            valid: false,
            item: access.item,
            isMaster: false,
            allowedLockers: [],
            accessibleLockersMask: 0,
            returnStarted: false,
            returnError: error.message || "Nie udało się rozpocząć zwrotu."
          };
        }
      }

      await this.createLog({
        event: "RFID_ACCESS_DENIED",
        source: context.source || "rfid-user",
        actor: assertValidTagId(tagId),
        tagId: access.item.tagId,
        itemName: access.item.itemName,
        itemType: access.item.itemType,
        itemKnown: access.item.itemKnown
      });

      return {
        valid: false,
        item: access.item,
        isMaster: false,
        allowedLockers: [],
        accessibleLockersMask: 0
      };
    }

    const accessMask = buildAccessMask(access.allowedLockers);
    const source = context.source || (access.isMaster ? "rfid-master" : "rfid-user");
    const actor = buildAccessSelectionActor(access.user?.name, access.user?.tagId);

    if (access.allowedLockers.length === 0) {
      await this.createLog({
        event: "access_denied_no_lockers",
        source,
        actor,
        success: false,
        tagId: access.item.tagId,
        itemName: access.item.itemName,
        itemType: access.item.itemType,
        itemKnown: access.item.itemKnown,
        details: {
          userId: access.user?.id || null,
          accessibleLockersMask: accessMask,
          isMaster: access.isMaster
        }
      });
    } else {
      await this.createLog({
        event: "RFID_ACCESS_GRANTED",
        source,
        actor,
        success: true,
        tagId: access.item.tagId,
        itemName: access.item.itemName,
        itemType: access.item.itemType,
        itemKnown: access.item.itemKnown,
        details: {
          userId: access.user?.id || null,
          accessibleLockersMask: accessMask,
          isMaster: access.isMaster
        }
      });
    }

    return {
      valid: true,
      item: access.item,
      user: access.user,
      isMaster: access.isMaster,
      allowedLockers: [...access.allowedLockers],
      accessibleLockersMask: accessMask,
      openedLockers: []
    };
  }

  async handleAccessSelectionEvent(payload = {}, context = {}) {
    const event = normalizeAccessSelectionEvent(payload.event);
    const tagId = normalizeString(payload.tagId, null);
    const userId = normalizeString(payload.userId, null);
    const userName = normalizeString(payload.userName, null);
    const requestId = normalizeString(payload.requestId, null);
    const source = context.source || "device";
    const actor = buildAccessSelectionActor(userName, tagId, context.actor || "device");
    const accessibleLockersMask = Number(payload.accessibleLockersMask) & ((1 << ALLOWED_LOCKERS.length) - 1);
    const locker = payload.locker == null || payload.locker === ""
      ? null
      : assertValidLocker(Number(payload.locker));
    const selectionKey = normalizeString(payload.selectionKey, null);
    const isMaster = payload.isMaster === true;

    const baseLogPayload = {
      event,
      source,
      actor,
      tagId,
      success: !["access_selection_invalid_locker", "access_denied_no_lockers"].includes(event),
      details: {
        userId,
        userName,
        accessibleLockersMask,
        isMaster,
        requestId,
        selectionKey
      }
    };

    if (locker != null) {
      baseLogPayload.locker = locker;
    }

    if (event === "access_selection_open_single") {
      if (locker == null || (accessibleLockersMask & (1 << (locker - 1))) === 0) {
        throw createHttpError(403, "Wybrana skrytka nie jest dostepna w tej sesji.");
      }

      const log = await this.createLog(baseLogPayload);
      const action = await this.openLocker(locker, {
        source,
        actor
      });

      return {
        logged: true,
        logId: log._id.toString(),
        locker,
        actionIds: [action.actionId]
      };
    }

    if (event === "access_selection_open_all") {
      const lockers = maskToLockers(accessibleLockersMask);
      if (lockers.length === 0) {
        throw createHttpError(403, "Brak skrytek do otwarcia w tej sesji.");
      }

      const log = await this.createLog({
        ...baseLogPayload,
        details: {
          ...baseLogPayload.details,
          lockers
        }
      });
      const actions = await this.openMultipleLockers(lockers, {
        source,
        actor
      });

      return {
        logged: true,
        logId: log._id.toString(),
        lockers,
        actionIds: actions.map(action => action.actionId)
      };
    }

    const log = await this.createLog(baseLogPayload);
    return {
      logged: true,
      logId: log._id.toString()
    };
  }

  async clearLogs(context = {}) {
    await Log.deleteMany({});
    this.emit("logs-cleared", {
      source: context.source || "web",
      actor: context.actor || null
    });
    return { success: true };
  }
}

module.exports = {
  lockerService: new LockerService(),
  createHttpError
};
