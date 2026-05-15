const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['subscription', 'marketplace'], default: 'subscription' },
  
  // --- SUBSCRIPTION FIELDS ---
  listingSubType: { type: String, enum: ['typeA', 'typeB'] },
  totalSlots: { type: Number },
  filledSlots: { type: Number, default: 0 },
  pricePerSlot: { type: Number },
  subscriptionCost: { type: Number, default: null },
  duration: { type: Number },
  credentialsType: { type: String, enum: ['email_password', 'profile_pin', 'family_link'] },
  autoRenew: { type: Boolean, default: false },

  // --- MARKETPLACE FIELDS ---
  category: { type: String, enum: ['gift_card', 'gaming_currency', 'game_key', 'ott_voucher', 'other'] },
  brand: { type: String },
  faceValue: { type: Number },
  sellingPrice: { type: Number },
  quantity: { type: Number, default: 1 },
  deliveryTime: { type: Number }, // in hours
  proofUrl: { type: String },
  inventoryCodes: [{ type: String }], // AES-256 encrypted codes stored here
  
  // --- COMMON FIELDS ---
  platform: { type: String, required: true }, // E.g. Netflix, Amazon, Steam
  deliveryMethod: { type: String, enum: ['instant', 'manual'], required: true },
  description: { type: String, default: '', maxlength: 300 },
  status: { type: String, enum: ['pending_review', 'active', 'inactive', 'paused', 'completed', 'rejected'], default: 'pending_review' }
}, { timestamps: true });

schema.index({ status: 1, type: 1 });
schema.index({ sellerId: 1 });

module.exports = mongoose.model('Listing', schema);
