const router = require('express').Router();
const mongoose = require('mongoose');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const WalletAccount = require('../models/WalletAccount');
const WalletTransaction = require('../models/WalletTransaction');
const { authenticate } = require('../middleware/auth');
const BRAND = require('../../../brand.config');

const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error('❌ RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing — wallet topup will fail');
}

router.get('/', authenticate, async (req, res, next) => {
  try {
    let wallet = await WalletAccount.findOne({ user_id: req.user._id });
    if (!wallet) wallet = await WalletAccount.create({ user_id: req.user._id });
    res.json({ success: true, data: wallet });
  } catch (err) { next(err); }
});

// ─── GET /wallet/transactions — with filters ─────────────────
router.get('/transactions', authenticate, async (req, res, next) => {
  try {
    const wallet = await WalletAccount.findOne({ user_id: req.user._id });
    if (!wallet) return res.json({ success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const filter = { wallet_id: wallet._id };

    // Filters
    if (req.query.type) filter.type = req.query.type; // 'credit' or 'debit'
    if (req.query.source) filter.source = req.query.source;
    if (req.query.search) {
      filter.description = { $regex: req.query.search, $options: 'i' };
    }
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const [txns, total] = await Promise.all([
      WalletTransaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      WalletTransaction.countDocuments(filter),
    ]);
    res.json({ success: true, data: txns, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// ─── GET /wallet/transactions/export.csv ─────────────────────
router.get('/transactions/export.csv', authenticate, async (req, res, next) => {
  try {
    const wallet = await WalletAccount.findOne({ user_id: req.user._id });
    if (!wallet) return res.status(404).json({ success: false, message: 'No wallet found' });

    const filter = { wallet_id: wallet._id };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }

    const txns = await WalletTransaction.find(filter).sort({ createdAt: -1 }).limit(500);
    const rows = ['Date,Type,Source,Amount,Balance After,Description'];
    txns.forEach(t => {
      rows.push(`"${new Date(t.createdAt).toISOString()}","${t.type}","${t.source}","${t.amount}","${t.balance_after}","${(t.description || '').replace(/"/g, '""')}"`);
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=wallet_statement.csv');
    res.send(rows.join('\n'));
  } catch (err) { next(err); }
});

// ─── POST /wallet/topup/initiate — Create Razorpay order ─────
router.post('/topup/initiate', authenticate, async (req, res, next) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < BRAND.wallet.minTopup || amount > BRAND.wallet.maxTopup) {
      return res.status(400).json({ success: false, message: `Amount must be between ${BRAND.formatPrice(BRAND.wallet.minTopup)} and ${BRAND.formatPrice(BRAND.wallet.maxTopup)}` });
    }

    const wallet = await WalletAccount.findOne({ user_id: req.user._id });
    if (wallet && wallet.balance + amount > BRAND.wallet.maxBalance) {
      return res.status(400).json({ success: false, message: `Max wallet balance is ${BRAND.formatPrice(BRAND.wallet.maxBalance)}` });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // paise
      currency: 'INR',
      receipt: `topup_${req.user._id}_${Date.now()}`,
      notes: { user_id: req.user._id.toString(), type: 'wallet_topup', amount: String(amount) },
    });

    res.json({
      success: true,
      data: {
        order_id: order.id, amount, currency: 'INR',
        key_id: process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (err) { next(err); }
});

// ─── POST /wallet/topup/verify — Verify payment & credit ────
router.post('/topup/verify', authenticate, async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !amount) {
      return res.status(400).json({ success: false, message: 'Missing payment fields' });
    }

    // Verify signature
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    // Idempotency: check if already credited for this payment
    const existingTx = await WalletTransaction.findOne({ razorpay_payment_id }).session(session);
    if (existingTx) {
      await session.abortTransaction();
      const wallet = await WalletAccount.findOne({ user_id: req.user._id });
      return res.json({ success: true, data: { wallet, message: 'Already processed' } });
    }

    let wallet = await WalletAccount.findOne({ user_id: req.user._id }).session(session);
    if (!wallet) wallet = await WalletAccount.create([{ user_id: req.user._id }], { session }).then(r => r[0]);

    const parsedAmount = parseFloat(amount);
    if (wallet.balance + parsedAmount > BRAND.wallet.maxBalance) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: `Max wallet balance is ${BRAND.formatPrice(BRAND.wallet.maxBalance)}` });
    }

    wallet.balance += parsedAmount;
    await wallet.save({ session });

    await WalletTransaction.create([{
      wallet_id: wallet._id, type: 'credit', amount: parsedAmount,
      balance_after: wallet.balance, source: 'topup',
      description: `Wallet top-up of ${BRAND.formatPrice(parsedAmount)}`,
      razorpay_order_id, razorpay_payment_id,
    }], { session });

    await session.commitTransaction();
    res.json({ success: true, data: { wallet } });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally { session.endSession(); }
});

// ─── Legacy POST /wallet/topup — redirect ───────────────────
router.post('/topup', authenticate, (req, res) => {
  res.status(410).json({ success: false, message: 'Use /wallet/topup/initiate instead' });
});

module.exports = router;
