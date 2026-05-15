const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  issueType: { type: String, required: true },
  description: { type: String, required: true },
  proofUrl: { type: String },
  sellerResponse: { type: String },
  status: { type: String, enum: ['open', 'seller_responded', 'resolved', 'closed'], default: 'open' },
  resolution: { type: String, enum: ['refunded', 'released', 'partial'] },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  adminNote: { type: String },
  resolvedAt: { type: Date }
}, { timestamps: true });

schema.index({ orderId: 1 });
schema.index({ raisedBy: 1 });
schema.index({ status: 1 });

module.exports = mongoose.model('Dispute', schema);
