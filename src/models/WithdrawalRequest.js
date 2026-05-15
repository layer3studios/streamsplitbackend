const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  sellerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 100 },
  method: { type: String, enum: ['upi', 'bank'], required: true },
  upiId: { type: String },
  bankAccount: { type: String },
  ifsc: { type: String },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  processedAt: { type: Date },
  transactionRef: { type: String },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: { createdAt: 'requestedAt', updatedAt: 'updatedAt' } });

schema.index({ sellerId: 1, createdAt: -1 });
schema.index({ status: 1 });

module.exports = mongoose.model('Withdrawal', schema);
