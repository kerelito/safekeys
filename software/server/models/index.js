const mongoose = require("mongoose");

const RFID_ITEM_STATUSES = ["IN_LOCKER", "CHECKED_OUT", "RETURN_PENDING", "UNKNOWN", "CONFLICT"];
const RETURN_SESSION_STATUSES = [
  "WAITING_FOR_ITEM",
  "ITEM_DETECTED",
  "WAITING_FOR_DOOR_CLOSE",
  "COMPLETED",
  "MISMATCH",
  "EXPIRED",
  "CANCELLED",
  "BLOCKED"
];

const CodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    match: /^\d{4}$/
  },
  locker: {
    type: Number,
    required: true,
    min: 1
  },
  active: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true
  },
  recipientEmail: {
    type: String,
    default: null,
    trim: true,
    lowercase: true
  },
  emailDeliveryAttempted: {
    type: Boolean,
    default: false
  },
  emailSentAt: {
    type: Date,
    default: null
  },
  emailDeliveryError: {
    type: String,
    default: null
  }
});

const LogSchema = new mongoose.Schema({
  event: {
    type: String,
    required: true
  },
  code: String,
  locker: Number,
  tagId: String,
  itemName: String,
  itemType: String,
  itemKnown: Boolean,
  recipientEmail: {
    type: String,
    default: null,
    trim: true,
    lowercase: true
  },
  errorMessage: String,
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  success: Boolean,
  source: String,
  actor: String,
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const LockerSchema = new mongoose.Schema({
  locker: {
    type: Number,
    required: true,
    unique: true,
    min: 1
  },
  hasTag: {
    type: Boolean,
    required: true
  },
  isDoorClosed: {
    type: Boolean,
    default: true
  },
  detectedTagId: {
    type: String,
    default: null
  },
  detectedItemName: {
    type: String,
    default: null
  },
  detectedItemType: {
    type: String,
    default: null
  },
  detectedItemKnown: {
    type: Boolean,
    default: null
  },
  detectedAt: {
    type: Date,
    default: null
  }
});

const DeviceCommandSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: [
      "OPEN_LOCKER",
      "RELEASE_ALL_LOCKERS",
      "ASSIGN_RFID_TAG",
      "CANCEL_RFID_TAG_ASSIGNMENT"
    ]
  },
  locker: {
    type: Number,
    default: null
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  source: {
    type: String,
    default: "web"
  },
  actor: {
    type: String,
    default: null
  },
  status: {
    type: String,
    required: true,
    enum: ["pending", "delivered", "acknowledged", "applied", "failed"],
    default: "pending"
  },
  idempotencyKey: {
    type: String,
    trim: true
  },
  deliveryCount: {
    type: Number,
    default: 0
  },
  deliveredAt: {
    type: Date,
    default: null
  },
  lastDeliveryAt: {
    type: Date,
    default: null
  },
  acknowledgedAt: {
    type: Date,
    default: null
  },
  appliedAt: {
    type: Date,
    default: null
  },
  failedAt: {
    type: Date,
    default: null
  },
  deliveries: [{
    at: {
      type: Date,
      default: Date.now
    },
    transport: {
      type: String,
      default: null
    },
    deviceId: {
      type: String,
      default: null
    }
  }],
  result: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true
});

DeviceCommandSchema.index({ status: 1, createdAt: 1 });
DeviceCommandSchema.index({ idempotencyKey: 1 }, {
  unique: true,
  sparse: true
});

const DeviceStateSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  connected: {
    type: Boolean,
    default: false
  },
  transport: {
    type: String,
    default: null
  },
  connectionId: {
    type: String,
    default: null
  },
  bootId: {
    type: String,
    default: null
  },
  protocolVersion: {
    type: Number,
    default: 1
  },
  lastSeenAt: {
    type: Date,
    default: null
  },
  lastConnectedAt: {
    type: Date,
    default: null
  },
  lastDisconnectedAt: {
    type: Date,
    default: null
  },
  disconnectReason: {
    type: String,
    default: null
  },
  lastMessageId: {
    type: String,
    default: null
  },
  lastSequence: {
    type: Number,
    default: 0
  },
  pingMs: {
    type: Number,
    default: null
  },
  wifiRssi: {
    type: Number,
    default: null
  },
  ip: {
    type: String,
    default: null
  },
  firmware: {
    type: String,
    default: null
  },
  uptimeMs: {
    type: Number,
    default: null
  },
  freeHeap: {
    type: Number,
    default: null
  },
  minFreeHeap: {
    type: Number,
    default: null
  },
  lockersWithTags: {
    type: Number,
    default: null
  },
  masterReaderPresent: {
    type: Boolean,
    default: null
  },
  networkFailureCount: {
    type: Number,
    default: null
  },
  configVersion: {
    type: Number,
    default: 1
  },
  servicePanelIp: {
    type: String,
    default: null
  },
  servicePanelActive: {
    type: Boolean,
    default: null
  },
  lockers: [{
    locker: Number,
    hasTag: Boolean,
    tagId: {
      type: String,
      default: null
    },
    doorClosed: {
      type: Boolean,
      default: null
    },
    lockClosed: {
      type: Boolean,
      default: null
    },
    version: {
      type: Number,
      default: 0
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

const DeviceConfigSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  version: {
    type: Number,
    default: 1,
    min: 1
  },
  config: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  updatedBy: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

const DeviceMessageReceiptSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  deviceId: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    required: true
  },
  sequence: {
    type: Number,
    default: null
  },
  status: {
    type: String,
    enum: ["processed", "rejected"],
    default: "processed"
  },
  response: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  receivedAt: {
    type: Date,
    default: Date.now
  }
});

const RfidUserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  tagId: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  allowedLockers: [{
    type: Number,
    required: true
  }],
  active: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const RfidItemSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  tagId: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  itemType: {
    type: String,
    required: true,
    enum: ["brelok", "karta", "inne", "klucz_master", "karta_master"]
  },
  assignedLocker: {
    type: Number,
    default: null,
    min: 1
  },
  status: {
    type: String,
    enum: RFID_ITEM_STATUSES,
    default: "UNKNOWN"
  },
  lastSeenAt: {
    type: Date,
    default: null
  },
  lastMovementAt: {
    type: Date,
    default: null
  },
  active: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

RfidItemSchema.index({ assignedLocker: 1 });
RfidItemSchema.index({ status: 1 });

const ReturnSessionSchema = new mongoose.Schema({
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "RfidItem",
    required: true
  },
  locker: {
    type: Number,
    required: true,
    min: 1
  },
  expectedUid: {
    type: String,
    required: true,
    uppercase: true,
    trim: true
  },
  detectedUid: {
    type: String,
    default: null,
    uppercase: true,
    trim: true
  },
  itemName: {
    type: String,
    default: null,
    trim: true
  },
  status: {
    type: String,
    required: true,
    enum: RETURN_SESSION_STATUSES,
    default: "WAITING_FOR_ITEM"
  },
  startedAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true
  },
  completedAt: {
    type: Date,
    default: null
  },
  failedAt: {
    type: Date,
    default: null
  },
  failureReason: {
    type: String,
    default: null
  },
  initiatedByUserId: {
    type: String,
    default: null
  },
  initiatedByUid: {
    type: String,
    default: null,
    uppercase: true,
    trim: true
  },
  sourceReader: {
    type: String,
    default: "MASTER",
    trim: true
  },
  commandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DeviceCommand",
    default: null
  }
}, {
  timestamps: true
});

ReturnSessionSchema.index({ itemId: 1, status: 1 });
ReturnSessionSchema.index({ locker: 1, status: 1 });
ReturnSessionSchema.index({ status: 1, expiresAt: 1 });

const PanelUserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  role: {
    type: String,
    required: true,
    enum: ["master", "admin", "operator", "viewer"],
    default: "admin"
  },
  active: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const Code = mongoose.models.Code || mongoose.model("Code", CodeSchema);
const Log = mongoose.models.Log || mongoose.model("Log", LogSchema);
const Locker = mongoose.models.Locker || mongoose.model("Locker", LockerSchema);
const DeviceCommand = mongoose.models.DeviceCommand || mongoose.model("DeviceCommand", DeviceCommandSchema);
const DeviceConfig = mongoose.models.DeviceConfig || mongoose.model("DeviceConfig", DeviceConfigSchema);
const DeviceState = mongoose.models.DeviceState || mongoose.model("DeviceState", DeviceStateSchema);
const DeviceMessageReceipt = mongoose.models.DeviceMessageReceipt || mongoose.model("DeviceMessageReceipt", DeviceMessageReceiptSchema);
const RfidUser = mongoose.models.RfidUser || mongoose.model("RfidUser", RfidUserSchema);
const RfidItem = mongoose.models.RfidItem || mongoose.model("RfidItem", RfidItemSchema);
const ReturnSession = mongoose.models.ReturnSession || mongoose.model("ReturnSession", ReturnSessionSchema);
const PanelUser = mongoose.models.PanelUser || mongoose.model("PanelUser", PanelUserSchema);

module.exports = {
  Code,
  DeviceCommand,
  DeviceConfig,
  DeviceMessageReceipt,
  DeviceState,
  Log,
  Locker,
  RfidUser,
  RfidItem,
  RFID_ITEM_STATUSES,
  ReturnSession,
  RETURN_SESSION_STATUSES,
  PanelUser
};
