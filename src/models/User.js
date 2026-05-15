const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: '' },
  email: { type: String, default: null },
  avatarUrl: { type: String, default: '' },
  language: { type: String, default: 'en' },
  role: { type: String, enum: ['buyer', 'seller', 'both', 'admin', 'super_admin'], default: 'both' },
  status: { type: String, enum: ['active', 'blocked', 'deleted'], default: 'active' },
  walletBalance: { type: Number, default: 0 },
  kycStatus: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
  sellerListingCount: { type: Number, default: 0 },
  isVerified: { type: Boolean, default: true },
  isBanned: { type: Boolean, default: false },
  sellerPlan: { type: String, default: 'free' },
  sellerPlanExpiry: { type: Date, default: null },
  deviceInfo: { os: String, model: String, appVersion: String },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastLoginAt: Date,
}, { timestamps: true });
module.exports = mongoose.model('User', schema);
