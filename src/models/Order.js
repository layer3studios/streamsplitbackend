const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  type: { type: String, enum: ['subscription', 'marketplace'], default: 'subscription' },
  buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  platform: { type: String, required: true },
  amount: { type: Number, required: true }, // paidAmount for marketplace
  status: { 
    type: String, 
    enum: ['pending', 'active', 'pending_delivery', 'delivered', 'failed', 'refunded', 'completed', 'disputed'], 
    default: 'pending' 
  },
  paymentId: { type: String }, // Razorpay payment ID
  pgOrderId: { type: String }, // Razorpay order ID
  
  // --- SUBSCRIPTION FIELDS ---
  duration: { type: Number }, // in days
  escrowAmount: { type: Number, default: 0 },
  escrowReleased: { type: Number, default: 0 },
  escrowPending: { type: Number, default: 0 },
  releaseStartDate: { type: Date },
  releaseEndDate: { type: Date },
  credentials: {
    email: { type: String },
    password: { type: String },
    profileName: { type: String }
  },

  // --- MARKETPLACE FIELDS ---
  category: { type: String },
  faceValue: { type: Number },
  deliveryMethod: { type: String, enum: ['instant', 'manual'] },
  deliveredCode: { type: String }, // Decrypted and saved here for buyer to see
  deliveredAt: { type: Date },
  confirmDeadline: { type: Date }, // Time given to buyer to confirm or dispute
  autoReleaseAt: { type: Date }, // Time when funds are auto-released to seller
}, { timestamps: true });

schema.index({ buyerId: 1, createdAt: -1 });
schema.index({ sellerId: 1 });
schema.index({ pgOrderId: 1 });

module.exports = mongoose.model('Order', schema);
