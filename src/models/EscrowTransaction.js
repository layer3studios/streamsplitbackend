const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  amountReleased: { type: Number, required: true },
  releaseDate: { type: Date, required: true },
  sellerWalletBefore: { type: Number, required: true },
  sellerWalletAfter: { type: Number, required: true },
  type: { type: String, enum: ['daily_release', 'full_release', 'refund', 'dispute_release'], default: 'daily_release' }
}, { timestamps: true });

// Ensure we only release once per order per day (using string for YYYY-MM-DD or start of day Date)
schema.index({ orderId: 1, releaseDate: 1 }, { unique: true });

module.exports = mongoose.model('EscrowTransaction', schema);
