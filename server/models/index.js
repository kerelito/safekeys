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
  }
});

const LogSchema = new mongoose.Schema({
  event: {
    type: String,
    required: true
  },
  code: String,
  locker: Number,
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

const Code = mongoose.models.Code || mongoose.model("Code", CodeSchema);
const Log = mongoose.models.Log || mongoose.model("Log", LogSchema);
const Locker = mongoose.models.Locker || mongoose.model("Locker", LockerSchema);
const RfidUser = mongoose.models.RfidUser || mongoose.model("RfidUser", RfidUserSchema);

module.exports = {
  Code,
  Log,
  Locker,
  RfidUser
};
