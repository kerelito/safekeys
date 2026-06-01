const crypto = require("crypto");
const { EventEmitter } = require("events");
const mongoose = require("mongoose");
const {
  Code,
  DeviceCommand,
  DeviceConfig,
  DeviceMessageReceipt,
  DeviceState,
  Log,
  Locker,
  RfidUser,
  RfidItem,
  ReturnSession
} = require("../models");
const {
  ALLOWED_LOCKERS,
  assertValidAllowedLockers,
  assertValidAssignedLocker,
  assertValidCode,
  assertValidDoorClosed,
  assertValidHasTag,
  assertValidHours,
  assertValidLocker,
  assertValidRecipientEmail,
  assertValidRfidItemName,
  assertValidRfidItemStatus,
  assertValidRfidItemType,
  assertValidTagId,
  assertValidUserName,
  createHttpError
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

const MASTER_RFID_ITEM_TYPES = new Set(["klucz_master", "karta_master"]);
const DEVICE_HEARTBEAT_TIMEOUT_MS = Number(process.env.DEVICE_HEARTBEAT_TIMEOUT_MS) || 180 * 1000;
const DEVICE_COMMAND_REDELIVER_AFTER_MS = Number(process.env.DEVICE_COMMAND_REDELIVER_AFTER_MS) || 30 * 1000;
const DEVICE_COMMAND_DELIVERY_LIMIT = Number(process.env.DEVICE_COMMAND_DELIVERY_LIMIT) || 20;
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
const RETURN_ACTIVE_SESSION_STATUSES = new Set(["WAITING_FOR_ITEM", "ITEM_DETECTED", "WAITING_FOR_DOOR_CLOSE"]);
const RETURN_TERMINAL_SESSION_STATUSES = new Set(["COMPLETED", "MISMATCH", "EXPIRED", "CANCELLED", "BLOCKED"]);
const RETURN_BLOCK_MESSAGES = {
  UNKNOWN_UID: "Nieznany tag RFID. Nie otwieram żadnej skrytki.",
  USER_TAG: "Ten UID należy do użytkownika RFID. Nie uruchamiam zwrotu przedmiotu.",
  NO_LOCKER_ASSIGNMENT: "Ten przedmiot nie ma przypisanej skrytki. Przypisz skrytkę w widoku Przedmioty RFID.",
  ITEM_NOT_CHECKED_OUT: "Ten przedmiot nie jest oznaczony jako wydany.",
  LOCKER_OCCUPIED: locker => `Nie można rozpocząć zwrotu. Skrytka S${locker} nie jest pusta.`,
  LOCKER_READER_OFFLINE: locker => `Nie można rozpocząć zwrotu. Czytnik RFID skrytki S${locker} jest offline albo nie ma świeżego statusu.`,
  LOCKER_RETURN_IN_PROGRESS: locker => `Nie można rozpocząć zwrotu. Dla skrytki S${locker} trwa już inny zwrot.`,
  ITEM_RETURN_IN_PROGRESS: "Zwrot tego przedmiotu już trwa.",
  LOCKER_NOT_READY: locker => locker
    ? `Nie można rozpocząć zwrotu. Skrytka S${locker} nie jest gotowa.`
    : "Nie można rozpocząć zwrotu. Skrytka nie jest gotowa.",
  DOOR_NOT_CLOSED: locker => locker
    ? `Nie można rozpocząć zwrotu. Drzwi skrytki S${locker} nie są zamknięte.`
    : "Nie można rozpocząć zwrotu. Drzwi skrytki nie są zamknięte."
};

function isActiveReturnSessionStatus(status) {
  return RETURN_ACTIVE_SESSION_STATUSES.has(status);
}

function getReturnBlockMessage(reason, locker = null) {
  const message = RETURN_BLOCK_MESSAGES[reason];
  if (typeof message === "function") {
    return message(locker);
  }

  return message || "Nie można rozpocząć zwrotu.";
}

function isLockerReadyForReturn(locker = {}, config = {}, readerSnapshot = {}, activeSession = null) {
  if (!locker) {
    return {
      ready: false,
      reason: "LOCKER_NOT_READY",
      message: getReturnBlockMessage("LOCKER_NOT_READY")
    };
  }

  const lockerNumber = Number(locker.locker || locker.lockerId || readerSnapshot.locker);

  if (activeSession) {
    return {
      ready: false,
      reason: "LOCKER_RETURN_IN_PROGRESS",
      message: getReturnBlockMessage("LOCKER_RETURN_IN_PROGRESS", lockerNumber)
    };
  }

  if (readerSnapshot.readerOnline !== true) {
    return {
      ready: false,
      reason: "LOCKER_READER_OFFLINE",
      message: getReturnBlockMessage("LOCKER_READER_OFFLINE", lockerNumber)
    };
  }

  if (locker.hasTag === true || locker.detectedTagId || locker.tagId || locker.detectedUid) {
    return {
      ready: false,
      reason: "LOCKER_OCCUPIED",
      message: getReturnBlockMessage("LOCKER_OCCUPIED", lockerNumber)
    };
  }

  if (config.doorSensorsEnabled === true && locker.isDoorClosed !== true) {
    return {
      ready: false,
      reason: "DOOR_NOT_CLOSED",
      message: getReturnBlockMessage("DOOR_NOT_CLOSED", lockerNumber)
    };
  }

  return {
    ready: true,
    reason: null,
    message: "Skrytka gotowa na zwrot."
  };
}

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

function buildReturnLedState(session, now = new Date()) {
  if (!session || !isActiveReturnSessionStatus(session.status)) {
    return {
      returnActive: false,
      returnStatus: null,
      returnSecondsRemaining: null
    };
  }

  const expiresAtTime = session.expiresAt ? new Date(session.expiresAt).getTime() : 0;
  const returnSecondsRemaining = expiresAtTime
    ? Math.max(0, Math.ceil((expiresAtTime - now.getTime()) / 1000))
    : null;

  return {
    returnActive: true,
    returnStatus: session.status,
    returnSecondsRemaining
  };
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
    this.masterScanDebounce = new Map();
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
      servicePanelActive: null,
      masterReaderPresent: null
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
        servicePanelActive: typeof deviceState.servicePanelActive === "boolean" ? deviceState.servicePanelActive : null,
        masterReaderPresent: typeof deviceState.masterReaderPresent === "boolean" ? deviceState.masterReaderPresent : null
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

    await this.expireReturnSessions();
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
      servicePanelActive: this.deviceStatus.servicePanelActive,
      masterReaderPresent: this.deviceStatus.masterReaderPresent
    };
  }

  getReturnRuntimeConfig(config = DEFAULT_DEVICE_CONFIG) {
    return normalizeDeviceConfig(config).returns;
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
      servicePanelActive: typeof payload.servicePanelActive === "boolean" ? payload.servicePanelActive : this.deviceStatus.servicePanelActive,
      masterReaderPresent: typeof payload.masterReaderPresent === "boolean" ? payload.masterReaderPresent : this.deviceStatus.masterReaderPresent
    };

    await DeviceState.findOneAndUpdate(
      { deviceId },
      { $set: update, $setOnInsert: { deviceId } },
      { upsert: true, new: true }
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
      { new: true }
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
      { upsert: true, new: true }
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
        case "hello": {
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

        case "return.master-scan": {
          const returnScan = await this.handleMasterRfidScan({
            uid: envelope.payload?.uid || envelope.payload?.tagId,
            readerId: envelope.payload?.readerId || "MASTER"
          }, {
            source: "device",
            actor: deviceId,
            deviceId
          });
          response = buildAck(envelope, {
            returnScan
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

  async getReturnConfig(deviceId = DEFAULT_DEVICE_ID) {
    const deviceConfig = await this.getDeviceConfig(deviceId);
    return this.getReturnRuntimeConfig(deviceConfig.config);
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
      ota: {
        ...(previousConfig.ota || {}),
        ...(incomingConfig.ota || {})
      },
      diagnostics: {
        ...(previousConfig.diagnostics || {}),
        ...(incomingConfig.diagnostics || {})
      },
      returns: {
        ...(previousConfig.returns || {}),
        ...(incomingConfig.returns || {})
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
      { upsert: true, new: true }
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
    const itemStatusWrites = [];
    const lockerEvents = [];

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

        if (previousItem?.tagId && previousItem.itemKnown === true) {
          itemStatusWrites.push({
            updateOne: {
              filter: { tagId: previousItem.tagId },
              update: {
                $set: {
                  status: "CHECKED_OUT",
                  lastMovementAt: now,
                  updatedAt: now
                }
              }
            }
          });
        }
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
      itemStatusWrites.length > 0
        ? RfidItem.bulkWrite(itemStatusWrites, { ordered: false })
        : Promise.resolve(),
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
            lockers: [...storedLockers.values()].sort((a, b) => a.locker - b.locker),
            ...(typeof payload.masterReaderPresent === "boolean" ? { masterReaderPresent: payload.masterReaderPresent } : {})
          }
        },
        { upsert: true, new: true }
      )
    ]);

    for (const event of lockerEvents) {
      if (event.hasTag && event.detectedTagId) {
        const returnResult = await this.handleReturnForLockerState(event.locker, event.detectedTagId, {
          source: event.source || "device-sync",
          actor: deviceId,
          deviceId,
          isDoorClosed: event.isDoorClosed
        });

        if (!returnResult && event.detectedItemKnown === true) {
          await RfidItem.updateOne(
            { tagId: event.detectedTagId },
            {
              $set: {
                status: "IN_LOCKER",
                lastSeenAt: now,
                lastMovementAt: now,
                updatedAt: now
              }
            }
          );
        }
      }

      if (event.isDoorClosed === true) {
        await this.handleReturnDoorStateChange(event.locker, true, {
          source: event.source || "device-sync",
          actor: deviceId,
          deviceId
        });
      }
    }

    for (const log of logs || []) {
      this.emit("log", log);
    }

    await this.decorateAcceptedLockersWithReturnState(accepted, new Date());

    for (const event of lockerEvents) {
      this.emit("locker-status-changed", event);
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
      lastSeenAt: now.toISOString(),
      masterReaderPresent: typeof payload.masterReaderPresent === "boolean" ? payload.masterReaderPresent : this.deviceStatus.masterReaderPresent
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

  buildReturnSessionPublic(session, itemOverride = null) {
    if (!session) {
      return null;
    }

    const plain = typeof session.toObject === "function" ? session.toObject() : session;
    const hasPopulatedItem = plain.itemId && typeof plain.itemId === "object" && plain.itemId.name;
    const populatedItem = itemOverride || (hasPopulatedItem ? plain.itemId : null);
    const itemId = populatedItem?._id || plain.itemId;
    const expiresAt = plain.expiresAt ? new Date(plain.expiresAt) : null;
    const secondsRemaining = expiresAt
      ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000))
      : null;

    return {
      id: String(plain._id || plain.id),
      _id: String(plain._id || plain.id),
      itemId: itemId ? String(itemId) : null,
      itemName: plain.itemName || populatedItem?.name || null,
      itemType: populatedItem?.itemType || null,
      locker: Number(plain.locker),
      lockerId: Number(plain.locker),
      expectedUid: plain.expectedUid || null,
      detectedUid: plain.detectedUid || null,
      status: plain.status,
      startedAt: plain.startedAt || plain.createdAt || null,
      expiresAt: plain.expiresAt || null,
      completedAt: plain.completedAt || null,
      failedAt: plain.failedAt || null,
      failureReason: plain.failureReason || null,
      initiatedByUserId: plain.initiatedByUserId || null,
      initiatedByUid: plain.initiatedByUid || null,
      sourceReader: plain.sourceReader || "MASTER",
      commandId: plain.commandId ? String(plain.commandId) : null,
      secondsRemaining,
      item: populatedItem
        ? this.normalizeRfidItem(populatedItem)
        : null
    };
  }

  async getActiveReturnSessions() {
    await this.expireReturnSessions();

    const sessions = await ReturnSession.find({
      status: { $in: [...RETURN_ACTIVE_SESSION_STATUSES] }
    }).sort({ expiresAt: 1 }).populate("itemId").lean();

    return sessions.map(session => this.buildReturnSessionPublic(session));
  }

  async getReturnAlerts() {
    await this.expireReturnSessions();

    const [activeSessions, failedSessions, unconfiguredItems, conflictItems] = await Promise.all([
      ReturnSession.find({ status: { $in: [...RETURN_ACTIVE_SESSION_STATUSES] } }).sort({ expiresAt: 1 }).populate("itemId").lean(),
      ReturnSession.find({ status: { $in: ["MISMATCH", "EXPIRED"] } }).sort({ updatedAt: -1 }).limit(8).lean(),
      RfidItem.find({
        active: true,
        itemType: { $nin: [...MASTER_RFID_ITEM_TYPES] },
        $or: [{ assignedLocker: null }, { assignedLocker: { $exists: false } }]
      }).sort({ name: 1 }).limit(8).lean(),
      RfidItem.find({ active: true, status: "CONFLICT" }).sort({ updatedAt: -1 }).limit(8).lean()
    ]);

    const alerts = [];
    activeSessions.forEach(session => {
      const publicSession = this.buildReturnSessionPublic(session);
      alerts.push({
        id: `return-active-${publicSession.id}`,
        severity: "info",
        title: `Trwa zwrot do S${publicSession.locker}`,
        detail: `${publicSession.itemName || "Przedmiot RFID"} oczekuje na wykrycie w skrytce. Timeout: ${publicSession.secondsRemaining ?? 0} s.`,
        action: "Włóż oczekiwany przedmiot do przypisanej skrytki."
      });
    });

    failedSessions.forEach(session => {
      const isMismatch = session.status === "MISMATCH";
      alerts.push({
        id: `return-${session.status.toLowerCase()}-${session._id}`,
        severity: isMismatch ? "critical" : "warning",
        title: isMismatch ? "Zwrot niezgodny UID" : "Zwrot niepotwierdzony",
        detail: isMismatch
          ? `S${session.locker}: oczekiwano ${session.expectedUid}, wykryto ${session.detectedUid || "brak danych"}.`
          : `S${session.locker}: ${session.itemName || session.expectedUid} nie został potwierdzony w czasie.`,
        action: "Sprawdź fizyczny stan skrytki i historię logów."
      });
    });

    unconfiguredItems.forEach(item => {
      alerts.push({
        id: `rfid-item-unconfigured-${item._id}`,
        severity: "warning",
        title: "Przedmiot bez przypisanej skrytki",
        detail: `${item.name} nie może zostać zwrócony automatycznie bez przypisanej skrytki.`,
        action: "Uzupełnij przypisanie w widoku Przedmioty RFID."
      });
    });

    conflictItems.forEach(item => {
      alerts.push({
        id: `rfid-item-conflict-${item._id}`,
        severity: "critical",
        title: "Konflikt przedmiotu RFID",
        detail: `${item.name} ma status konfliktu po zwrocie lub odczycie RFID.`,
        action: "Zweryfikuj UID i zawartość przypisanej skrytki."
      });
    });

    return alerts;
  }

  async getReturnSession(sessionId) {
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      throw createHttpError(400, "Nieprawidłowe ID sesji zwrotu.");
    }

    const session = await ReturnSession.findById(sessionId).populate("itemId").lean();
    if (!session) {
      throw createHttpError(404, "Nie znaleziono sesji zwrotu.");
    }

    return this.buildReturnSessionPublic(session);
  }

  async decorateAcceptedLockersWithReturnState(accepted = [], now = new Date()) {
    const lockerNumbers = [...new Set(accepted
      .filter(item => item?.accepted !== false && Number.isInteger(Number(item.locker)))
      .map(item => Number(item.locker)))];

    if (lockerNumbers.length === 0) {
      return accepted;
    }

    const sessions = await ReturnSession.find({
      locker: { $in: lockerNumbers },
      status: { $in: [...RETURN_ACTIVE_SESSION_STATUSES] }
    }).sort({ expiresAt: 1 }).lean();
    const sessionByLocker = new Map(sessions.map(session => [Number(session.locker), session]));

    accepted.forEach(item => {
      if (item?.accepted === false) {
        return;
      }

      Object.assign(item, buildReturnLedState(sessionByLocker.get(Number(item.locker)), now));
    });

    return accepted;
  }

  async getLockerReaderSnapshot(locker, config = {}) {
    const lockerNumber = Number(locker?.locker || locker?.lockerId);
    const deviceState = await DeviceState.findOne({ deviceId: DEFAULT_DEVICE_ID }).lean();
    const deviceStatus = this.getDeviceStatusSnapshot();
    const lockerState = (deviceState?.lockers || []).find(item => Number(item.locker) === lockerNumber) || null;
    const updatedAt = lockerState?.updatedAt || deviceState?.lastSeenAt || null;
    const freshnessMs = Number(config.readerFreshnessMs) || DEFAULT_DEVICE_CONFIG.returns.readerFreshnessMs;
    const updatedAtTime = updatedAt ? new Date(updatedAt).getTime() : 0;
    const fresh = Boolean(updatedAtTime) && Date.now() - updatedAtTime <= freshnessMs;

    return {
      locker: lockerNumber,
      readerOnline: Boolean(deviceStatus.connected && lockerState && fresh),
      updatedAt,
      detectedUid: lockerState?.tagId || locker?.detectedTagId || null
    };
  }

  async logReturnBlocked(reason, item, context = {}, details = {}) {
    const locker = details.locker || item?.assignedLocker || null;
    const eventByReason = {
      UNKNOWN_UID: "return_blocked_unknown_uid",
      USER_TAG: "master_scan_user_tag",
      NO_LOCKER_ASSIGNMENT: "return_blocked_no_assignment",
      ITEM_NOT_CHECKED_OUT: "return_blocked_item_not_checked_out",
      LOCKER_OCCUPIED: "return_blocked_locker_occupied",
      LOCKER_READER_OFFLINE: "return_blocked_reader_offline",
      LOCKER_RETURN_IN_PROGRESS: "return_blocked_session_exists",
      ITEM_RETURN_IN_PROGRESS: "return_blocked_session_exists",
      LOCKER_NOT_READY: "return_blocked_locker_not_ready",
      DOOR_NOT_CLOSED: "return_blocked_locker_not_ready"
    };

    await this.createLog({
      event: eventByReason[reason] || "return_blocked_locker_not_ready",
      locker,
      tagId: item?.tagId || details.uid || null,
      itemName: item?.name || null,
      itemType: item?.itemType || null,
      itemKnown: Boolean(item),
      success: false,
      errorMessage: getReturnBlockMessage(reason, locker),
      source: context.source || "rfid-master",
      actor: context.actor || details.uid || null,
      details: {
        reason,
        sourceReader: context.sourceReader || details.sourceReader || "MASTER",
        ...details
      }
    });
  }

  async createReturnSessionLog(event, session, item, context = {}, details = {}) {
    return this.createLog({
      event,
      locker: session.locker,
      tagId: session.expectedUid || item?.tagId || null,
      itemName: item?.name || session.itemName || null,
      itemType: item?.itemType || null,
      itemKnown: Boolean(item),
      success: !["return_mismatch", "return_expired", "return_cancelled"].includes(event),
      errorMessage: details.errorMessage || null,
      source: context.source || "return-flow",
      actor: context.actor || context.initiatedByUid || session.initiatedByUid || null,
      details: {
        returnSessionId: String(session._id || session.id),
        itemId: item?._id ? String(item._id) : String(session.itemId || ""),
        expectedUid: session.expectedUid,
        sourceReader: session.sourceReader || context.sourceReader || "MASTER",
        commandId: session.commandId ? String(session.commandId) : null,
        ...details
      }
    });
  }

  async handleMasterRfidScan(payload = {}, context = {}) {
    const uid = assertValidTagId(payload.uid || payload.tagId);
    const readerId = normalizeString(payload.readerId, "MASTER");
    const sourceReader = readerId.toUpperCase();
    const config = await this.getReturnConfig(context.deviceId || DEFAULT_DEVICE_ID);
    const debounceKey = `${sourceReader}:${uid}`;
    const lastScanAt = this.masterScanDebounce.get(debounceKey) || 0;
    const isDuplicate = Date.now() - lastScanAt <= config.masterScanDebounceMs;

    await this.createLog({
      event: "return_master_scan",
      tagId: uid,
      source: context.source || "rfid-master",
      actor: context.actor || uid,
      details: {
        sourceReader,
        duplicate: isDuplicate
      }
    });

    const [item, user] = await Promise.all([
      RfidItem.findOne({ tagId: uid, active: true }).lean(),
      RfidUser.findOne({ tagId: uid, active: true }).lean()
    ]);

    if (isDuplicate) {
      if (item) {
        const activeSession = await ReturnSession.findOne({
          itemId: item._id,
          status: { $in: [...RETURN_ACTIVE_SESSION_STATUSES] }
        }).populate("itemId").lean();

        if (activeSession) {
          return {
            ok: true,
            status: "RETURN_ALREADY_ACTIVE",
            message: "Zwrot już trwa.",
            item: this.normalizeRfidItem(item),
            locker: item.assignedLocker || null,
            returnSession: this.buildReturnSessionPublic(activeSession)
          };
        }
      }

      return {
        ok: false,
        status: "BLOCKED",
        reason: "DUPLICATE_SCAN",
        message: "Powtórzony odczyt został zignorowany."
      };
    }

    this.masterScanDebounce.set(debounceKey, Date.now());

    if (!item && !user) {
      await this.createLog({
        event: "master_scan_unknown_uid",
        tagId: uid,
        success: false,
        source: context.source || "rfid-master",
        actor: context.actor || uid,
        details: { sourceReader }
      });
      await this.logReturnBlocked("UNKNOWN_UID", null, context, { uid, sourceReader });
      return {
        ok: false,
        status: "BLOCKED",
        reason: "UNKNOWN_UID",
        message: getReturnBlockMessage("UNKNOWN_UID")
      };
    }

    if (user || isMasterRfidItemType(item?.itemType)) {
      await this.logReturnBlocked("USER_TAG", item || null, context, {
        uid,
        userId: user?._id ? String(user._id) : null,
        userName: user?.name || null,
        sourceReader,
        classification: user ? "rfid_user" : "admin_item"
      });
      return {
        ok: false,
        status: "BLOCKED",
        reason: "USER_TAG",
        message: getReturnBlockMessage("USER_TAG")
      };
    }

    return this.startReturnFlow(item, {
      ...context,
      initiatedByUid: uid,
      sourceReader
    });
  }

  async startReturnFlow(itemOrUid, context = {}) {
    const item = typeof itemOrUid === "string"
      ? await RfidItem.findOne({ tagId: assertValidTagId(itemOrUid), active: true }).lean()
      : itemOrUid;

    if (!item) {
      await this.logReturnBlocked("UNKNOWN_UID", null, context, {
        uid: typeof itemOrUid === "string" ? itemOrUid : null
      });
      return {
        ok: false,
        status: "BLOCKED",
        reason: "UNKNOWN_UID",
        message: getReturnBlockMessage("UNKNOWN_UID")
      };
    }

    const normalizedItem = this.normalizeRfidItem(item);
    const assignedLocker = normalizedItem.assignedLocker;
    if (!assignedLocker) {
      await this.logReturnBlocked("NO_LOCKER_ASSIGNMENT", normalizedItem, context);
      return {
        ok: false,
        status: "BLOCKED",
        reason: "NO_LOCKER_ASSIGNMENT",
        message: getReturnBlockMessage("NO_LOCKER_ASSIGNMENT"),
        item: normalizedItem
      };
    }

    const activeItemSession = await ReturnSession.findOne({
      itemId: item._id,
      status: { $in: [...RETURN_ACTIVE_SESSION_STATUSES] }
    }).populate("itemId").lean();

    if (activeItemSession) {
      await this.logReturnBlocked("ITEM_RETURN_IN_PROGRESS", normalizedItem, context, {
        locker: assignedLocker,
        activeReturnSessionId: String(activeItemSession._id)
      });
      return {
        ok: true,
        status: "RETURN_ALREADY_ACTIVE",
        message: getReturnBlockMessage("ITEM_RETURN_IN_PROGRESS"),
        item: normalizedItem,
        locker: assignedLocker,
        returnSession: this.buildReturnSessionPublic(activeItemSession)
      };
    }

    if (normalizedItem.status !== "CHECKED_OUT") {
      await this.logReturnBlocked("ITEM_NOT_CHECKED_OUT", normalizedItem, context, {
        status: normalizedItem.status
      });
      return {
        ok: false,
        status: "BLOCKED",
        reason: "ITEM_NOT_CHECKED_OUT",
        message: getReturnBlockMessage("ITEM_NOT_CHECKED_OUT"),
        item: normalizedItem
      };
    }

    const activeLockerSession = await ReturnSession.findOne({
      locker: assignedLocker,
      status: { $in: [...RETURN_ACTIVE_SESSION_STATUSES] }
    }).lean();

    if (activeLockerSession) {
      await this.logReturnBlocked("LOCKER_RETURN_IN_PROGRESS", normalizedItem, context, {
        locker: assignedLocker,
        activeReturnSessionId: String(activeLockerSession._id)
      });
      return {
        ok: false,
        status: "BLOCKED",
        reason: "LOCKER_RETURN_IN_PROGRESS",
        message: getReturnBlockMessage("LOCKER_RETURN_IN_PROGRESS", assignedLocker),
        item: normalizedItem,
        locker: assignedLocker
      };
    }

    const config = await this.getReturnConfig(context.deviceId || DEFAULT_DEVICE_ID);
    const lockerDoc = await Locker.findOne({ locker: assignedLocker }).lean();
    const lockerPayload = buildLockerStatePayload({
      locker: assignedLocker,
      hasTag: lockerDoc?.hasTag === true,
      isDoorClosed: lockerDoc ? lockerDoc.isDoorClosed !== false : true,
      detectedTagId: lockerDoc?.detectedTagId || null,
      detectedItemName: lockerDoc?.detectedItemName || null,
      detectedItemType: lockerDoc?.detectedItemType || null,
      detectedItemKnown: typeof lockerDoc?.detectedItemKnown === "boolean" ? lockerDoc.detectedItemKnown : null,
      detectedAt: lockerDoc?.detectedAt || null
    });
    const readerSnapshot = await this.getLockerReaderSnapshot(lockerPayload, config);
    const readiness = isLockerReadyForReturn(lockerPayload, config, readerSnapshot, null);

    if (!readiness.ready) {
      await this.logReturnBlocked(readiness.reason, normalizedItem, context, {
        locker: assignedLocker,
        readerSnapshot,
        doorSensorsEnabled: config.doorSensorsEnabled
      });
      return {
        ok: false,
        status: "BLOCKED",
        reason: readiness.reason,
        message: readiness.message,
        item: normalizedItem,
        locker: lockerPayload,
        readerSnapshot
      };
    }

    const now = new Date();
    const session = await ReturnSession.create({
      itemId: item._id,
      locker: assignedLocker,
      expectedUid: normalizedItem.tagId,
      itemName: normalizedItem.name,
      status: "WAITING_FOR_ITEM",
      startedAt: now,
      expiresAt: new Date(now.getTime() + config.returnSessionTimeoutSeconds * 1000),
      initiatedByUserId: context.userId ? String(context.userId) : null,
      initiatedByUid: context.initiatedByUid || normalizedItem.tagId,
      sourceReader: context.sourceReader || "MASTER"
    });

    await RfidItem.updateOne(
      { _id: item._id },
      {
        $set: {
          status: "RETURN_PENDING",
          lastMovementAt: now,
          updatedAt: now
        }
      }
    );

    const action = await this.createRemoteAction("OPEN_LOCKER", assignedLocker, {
      source: context.source || "return-flow",
      actor: context.actor || context.initiatedByUid || normalizedItem.tagId,
      payload: {
        reason: "RETURN_ITEM",
        expectedUid: normalizedItem.tagId,
        returnSessionId: String(session._id),
        returnStatus: "WAITING_FOR_ITEM",
        returnActive: true,
        returnTimeoutMs: config.returnSessionTimeoutSeconds * 1000,
        itemId: String(item._id),
        itemName: normalizedItem.name
      },
      idempotencyKey: `return-open:${session._id}`
    });

    session.commandId = action.id;
    await session.save();

    await this.createReturnSessionLog("return_started", session, normalizedItem, context, {
      doorSensorsEnabled: config.doorSensorsEnabled,
      confirmationMode: config.doorSensorsEnabled ? "RFID_AND_DOOR_CLOSED" : "RFID_ONLY"
    });
    await this.createReturnSessionLog("return_open_command_sent", session, normalizedItem, context, {
      commandId: action.id
    });

    const publicSession = this.buildReturnSessionPublic(session, {
      ...normalizedItem,
      status: "RETURN_PENDING"
    });
    this.emit("return-session-changed", publicSession);

    return {
      ok: true,
      status: "RETURN_STARTED",
      message: `Otwieram skrytkę S${assignedLocker}. Włóż przedmiot: ${normalizedItem.name}.`,
      item: {
        ...normalizedItem,
        status: "RETURN_PENDING"
      },
      locker: lockerPayload,
      returnSession: publicSession
    };
  }

  async handleReturnForLockerState(locker, detectedUid, context = {}) {
    const lockerNumber = Number(locker);
    assertValidLocker(lockerNumber);
    const session = await ReturnSession.findOne({
      locker: lockerNumber,
      status: { $in: [...RETURN_ACTIVE_SESSION_STATUSES] }
    });

    if (!session || RETURN_TERMINAL_SESSION_STATUSES.has(session.status)) {
      return null;
    }

    if (!detectedUid) {
      return this.buildReturnSessionPublic(session);
    }

    const normalizedUid = assertValidTagId(detectedUid);
    const item = await RfidItem.findById(session.itemId).lean();

    if (normalizedUid !== session.expectedUid) {
      return this.failReturnMismatch(session, normalizedUid, item, context);
    }

    await this.createReturnSessionLog("return_item_detected", session, item, context, {
      detectedUid: normalizedUid
    });

    const config = await this.getReturnConfig(context.deviceId || DEFAULT_DEVICE_ID);
    if (config.doorSensorsEnabled === true) {
      // Po włączeniu kontaktronów zwrot będzie czekał na domknięcie drzwi po zgodnym RFID.
      session.detectedUid = normalizedUid;
      if (context.isDoorClosed === true) {
        return this.completeReturnSession(session, item, context, "return_completed");
      }
      session.status = "WAITING_FOR_DOOR_CLOSE";
      await session.save();
      const publicSession = this.buildReturnSessionPublic(session, item);
      this.emit("return-session-changed", publicSession);
      return publicSession;
    }

    // Faza testowa bez kontaktronów: zgodny UID w czytniku skrytki kończy zwrot.
    session.detectedUid = normalizedUid;
    return this.completeReturnSession(session, item, context, "return_completed_rfid_only");
  }

  async completeReturnSession(session, item, context = {}, event = "return_completed") {
    if (!session || !isActiveReturnSessionStatus(session.status)) {
      return this.buildReturnSessionPublic(session, item);
    }

    const now = new Date();
    session.status = "COMPLETED";
    session.completedAt = now;
    session.failedAt = null;
    session.failureReason = null;
    await session.save();

    await RfidItem.updateOne(
      { _id: session.itemId },
      {
        $set: {
          status: "IN_LOCKER",
          lastSeenAt: now,
          lastMovementAt: now,
          updatedAt: now
        }
      }
    );

    await this.createReturnSessionLog(event, session, item, context, {
      completedAt: now,
      confirmationMode: event === "return_completed_rfid_only" ? "RFID_ONLY" : "RFID_AND_DOOR_CLOSED"
    });

    const publicSession = this.buildReturnSessionPublic(session, item ? { ...item, status: "IN_LOCKER" } : null);
    this.emit("return-session-changed", publicSession);
    return publicSession;
  }

  async failReturnMismatch(session, detectedUid, item, context = {}) {
    if (!session || !isActiveReturnSessionStatus(session.status)) {
      return this.buildReturnSessionPublic(session, item);
    }

    const now = new Date();
    session.status = "MISMATCH";
    session.detectedUid = detectedUid;
    session.failedAt = now;
    session.failureReason = "EXPECTED_UID_MISMATCH";
    await session.save();

    await RfidItem.updateOne(
      { _id: session.itemId },
      {
        $set: {
          status: "CONFLICT",
          lastMovementAt: now,
          updatedAt: now
        }
      }
    );

    const detectedItem = await RfidItem.findOne({ tagId: detectedUid, active: true }).lean();
    if (detectedItem) {
      await RfidItem.updateOne(
        { _id: detectedItem._id },
        {
          $set: {
            status: "CONFLICT",
            lastSeenAt: now,
            lastMovementAt: now,
            updatedAt: now
          }
        }
      );
    }

    await this.createReturnSessionLog("return_mismatch", session, item, context, {
      detectedUid,
      detectedItemId: detectedItem?._id ? String(detectedItem._id) : null,
      detectedItemName: detectedItem?.name || null,
      errorMessage: `Zwrot niezgodny. Oczekiwano UID ${session.expectedUid}, wykryto UID ${detectedUid}.`
    });

    const publicSession = this.buildReturnSessionPublic(session, item ? { ...item, status: "CONFLICT" } : null);
    this.emit("return-session-changed", publicSession);
    return publicSession;
  }

  async handleReturnDoorStateChange(locker, isDoorClosed, context = {}) {
    if (isDoorClosed !== true) {
      return null;
    }

    const config = await this.getReturnConfig(context.deviceId || DEFAULT_DEVICE_ID);
    if (config.doorSensorsEnabled !== true) {
      return null;
    }

    const lockerNumber = Number(locker);
    assertValidLocker(lockerNumber);
    const session = await ReturnSession.findOne({
      locker: lockerNumber,
      status: "WAITING_FOR_DOOR_CLOSE"
    });

    if (!session) {
      return null;
    }

    const lockerDoc = await Locker.findOne({ locker: lockerNumber }).lean();
    if (lockerDoc?.detectedTagId !== session.expectedUid) {
      return null;
    }

    const item = await RfidItem.findById(session.itemId).lean();
    return this.completeReturnSession(session, item, context, "return_completed");
  }

  async expireReturnSessions() {
    const now = new Date();
    const sessions = await ReturnSession.find({
      status: { $in: [...RETURN_ACTIVE_SESSION_STATUSES] },
      expiresAt: { $lte: now }
    });

    const expired = [];
    for (const session of sessions) {
      const item = await RfidItem.findById(session.itemId).lean();
      session.status = "EXPIRED";
      session.failedAt = now;
      session.failureReason = "TIMEOUT";
      await session.save();

      await RfidItem.updateOne(
        {
          _id: session.itemId,
          status: "RETURN_PENDING"
        },
        {
          $set: {
            status: "CHECKED_OUT",
            lastMovementAt: now,
            updatedAt: now
          }
        }
      );

      await this.createReturnSessionLog("return_expired", session, item, {
        source: "return-timeout",
        actor: "system"
      }, {
        errorMessage: "Zwrot nie został potwierdzony w wyznaczonym czasie.",
        failedAt: now
      });

      const publicSession = this.buildReturnSessionPublic(session, item ? { ...item, status: "CHECKED_OUT" } : null);
      this.emit("return-session-changed", publicSession);
      expired.push(publicSession);
    }

    return expired;
  }

  async cancelReturnSession(sessionId, context = {}) {
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      throw createHttpError(400, "Nieprawidłowe ID sesji zwrotu.");
    }

    const session = await ReturnSession.findById(sessionId);
    if (!session) {
      throw createHttpError(404, "Nie znaleziono sesji zwrotu.");
    }

    if (!isActiveReturnSessionStatus(session.status)) {
      return this.buildReturnSessionPublic(await session.populate("itemId"));
    }

    const now = new Date();
    const item = await RfidItem.findById(session.itemId).lean();
    session.status = "CANCELLED";
    session.failedAt = now;
    session.failureReason = context.reason || "MANUAL_CANCEL";
    await session.save();

    await RfidItem.updateOne(
      {
        _id: session.itemId,
        status: "RETURN_PENDING"
      },
      {
        $set: {
          status: "CHECKED_OUT",
          lastMovementAt: now,
          updatedAt: now
        }
      }
    );

    await this.createReturnSessionLog("return_cancelled", session, item, context, {
      reason: session.failureReason
    });

    const publicSession = this.buildReturnSessionPublic(session, item ? { ...item, status: "CHECKED_OUT" } : null);
    this.emit("return-session-changed", publicSession);
    return publicSession;
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

      if (previousItem?.tagId && previousItem.itemKnown === true) {
        await RfidItem.updateOne(
          { tagId: previousItem.tagId },
          {
            $set: {
              status: "CHECKED_OUT",
              lastMovementAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
      }
    }

    let returnSessionResult = null;
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

      if (nextItem?.tagId) {
        returnSessionResult = await this.handleReturnForLockerState(locker, nextItem.tagId, {
          source: context.source || "rfid",
          actor: context.actor || null,
          deviceId: context.deviceId,
          isDoorClosed: found.isDoorClosed !== false
        });
      }

      if (!returnSessionResult && nextItem?.tagId && nextItem.itemKnown === true) {
        await RfidItem.updateOne(
          { tagId: nextItem.tagId },
          {
            $set: {
              status: "IN_LOCKER",
              lastSeenAt: new Date(),
              lastMovementAt: new Date(),
              updatedAt: new Date()
            }
          }
        );
      }
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

    await this.handleReturnDoorStateChange(locker, isDoorClosed, {
      source: context.source || "contactron",
      actor: context.actor || null,
      deviceId: context.deviceId
    });

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
          { upsert: true, new: true, setDefaultsOnInsert: true }
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
    const [lockers, rfidUsers, rfidItems, activeCodes, logs, remoteActions, returnSessions] = await Promise.all([
      this.getLockers(),
      this.getRfidUsers(),
      this.getRfidItems(),
      this.getActiveCodes(),
      this.getLogs({ limit: 500 }),
      this.getRemoteActionHistory(),
      ReturnSession.find().sort({ createdAt: -1 }).limit(500).lean()
    ]);

    return {
      exportedAt: new Date().toISOString(),
      lockers,
      rfidUsers,
      rfidItems,
      activeCodes,
      logs,
      remoteActions,
      returnSessions: returnSessions.map(session => this.buildReturnSessionPublic(session))
    };
  }

  async getRfidUsers() {
    return RfidUser.find().sort({ name: 1 }).lean();
  }

  normalizeRfidItem(item = {}) {
    const plain = typeof item.toObject === "function" ? item.toObject() : item;
    const assignedLocker = plain.assignedLocker == null
      ? null
      : Number(plain.assignedLocker);
    const status = plain.status || "UNKNOWN";
    const requiresConfiguration = !isMasterRfidItemType(plain.itemType) && !assignedLocker;

    return {
      ...plain,
      _id: plain._id ? String(plain._id) : plain._id,
      assignedLocker,
      assigned_locker_id: assignedLocker,
      status: requiresConfiguration ? "UNKNOWN" : status,
      requiresConfiguration,
      lastSeenAt: plain.lastSeenAt || null,
      lastMovementAt: plain.lastMovementAt || null
    };
  }

  async getRfidItems() {
    const items = await RfidItem.find().sort({ name: 1 }).lean();
    return items.map(item => this.normalizeRfidItem(item));
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
    const isMasterItem = isMasterRfidItemType(itemType);
    const assignedLocker = isMasterItem
      ? assertValidAssignedLocker(payload.assignedLocker ?? payload.assigned_locker_id, { required: false })
      : assertValidAssignedLocker(payload.assignedLocker ?? payload.assigned_locker_id, { required: true });
    const status = isMasterItem
      ? "UNKNOWN"
      : assertValidRfidItemStatus(payload.status, "UNKNOWN");

    if (isMasterItem && context.role !== "master") {
      throw createHttpError(403, "Tylko użytkownik master może dodawać tagi administracyjne RFID.");
    }

    const existing = await RfidItem.findOne({ tagId });
    if (existing) {
      throw createHttpError(409, "Przedmiot RFID z tym tagiem juz istnieje.");
    }

    if (isMasterItem) {
      const existingUser = await RfidUser.findOne({ tagId });
      if (existingUser) {
        throw createHttpError(409, "Ten UID jest juz przypisany jako zwykly uzytkownik RFID.");
      }
    }

    const item = await RfidItem.create({
      name,
      tagId,
      itemType,
      assignedLocker,
      status,
      updatedAt: new Date()
    });

    await this.createLog({
      event: "RFID_ITEM_CREATED",
      source: context.source || "web",
      actor: `${context.actor || "system"} • ${name} • ${tagId}`,
      tagId,
      itemName: name,
      itemType,
      details: {
        assignedLocker,
        status
      }
    });

    if (this.currentTagAssignment?.result?.tagId === tagId || this.currentTagAssignment?.tagId === tagId) {
      this.currentTagAssignment = null;
      this.emit("rfid-tag-assignment-updated", null);
    }

    return this.normalizeRfidItem(item);
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

    const isMasterItem = isMasterRfidItemType(itemType);
    const assignedLocker = isMasterItem
      ? assertValidAssignedLocker(payload.assignedLocker ?? payload.assigned_locker_id, { required: false })
      : assertValidAssignedLocker(payload.assignedLocker ?? payload.assigned_locker_id, { required: true });
    const status = isMasterItem
      ? "UNKNOWN"
      : assertValidRfidItemStatus(payload.status, item.status || "UNKNOWN");

    const existingWithTag = await RfidItem.findOne({ tagId, _id: { $ne: itemId } });
    if (existingWithTag) {
      throw createHttpError(409, "Inny przedmiot RFID ma juz ten tag.");
    }

    if ((isMasterRfidItemType(item.itemType) || isMasterItem) && context.role !== "master") {
      throw createHttpError(403, "Tylko użytkownik master może edytować tagi administracyjne RFID.");
    }

    if (isMasterItem) {
      const existingUser = await RfidUser.findOne({ tagId });
      if (existingUser) {
        throw createHttpError(409, "Ten UID jest juz przypisany jako zwykly uzytkownik RFID.");
      }
    }

    const previousTagId = item.tagId;
    item.name = name;
    item.tagId = tagId;
    item.itemType = itemType;
    item.assignedLocker = assignedLocker;
    item.status = status;
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
      actor: `${context.actor || "system"} • ${name} • ${tagId}`,
      tagId,
      itemName: name,
      itemType,
      details: {
        assignedLocker,
        status
      }
    });

    if (this.currentTagAssignment?.result?.tagId === tagId || this.currentTagAssignment?.tagId === tagId) {
      this.currentTagAssignment = null;
      this.emit("rfid-tag-assignment-updated", null);
    }

    return this.normalizeRfidItem(item);
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
  RETURN_ACTIVE_SESSION_STATUSES,
  getReturnBlockMessage,
  isActiveReturnSessionStatus,
  isLockerReadyForReturn,
  createHttpError
};
