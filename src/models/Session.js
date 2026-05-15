const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  refreshTokenHash: { type: String },
  deviceInfo: { os: String, ip: String },
  isRevoked: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });
schema.index({ refreshTokenHash: 1 }, { unique: true, sparse: true });
schema.index({ userId: 1 });
module.exports = mongoose.model('Session', schema);
