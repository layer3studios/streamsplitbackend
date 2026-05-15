const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  hashedOtp: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });
module.exports = mongoose.model('OtpRequest', schema);
