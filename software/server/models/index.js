const mongoose = require("mongoose");

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
    enum: ["brelok", "karta", "inne"]
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
    enum: ["master", "admin"],
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
const RfidUser = mongoose.models.RfidUser || mongoose.model("RfidUser", RfidUserSchema);
const RfidItem = mongoose.models.RfidItem || mongoose.model("RfidItem", RfidItemSchema);
const PanelUser = mongoose.models.PanelUser || mongoose.model("PanelUser", PanelUserSchema);

module.exports = {
  Code,
  Log,
  Locker,
  RfidUser,
  RfidItem,
  PanelUser
};
