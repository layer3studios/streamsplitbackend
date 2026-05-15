const router = require('express').Router();
const Withdrawal = require('../models/WithdrawalRequest');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');

// POST /api/v1/withdrawals/request
router.post('/request', authenticate, async (req, res, next) => {
  try {
    const { amount, method, upiId, bankAccount, ifsc } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum withdrawal is ₹100' });
    }

    if (!['upi', 'bank'].includes(method)) {
      return res.status(400).json({ success: false, message: 'Invalid method' });
    }

    if (method === 'upi' && !upiId) {
      return res.status(400).json({ success: false, message: 'UPI ID is required' });
    }

    if (method === 'bank' && (!bankAccount || !ifsc)) {
      return res.status(400).json({ success: false, message: 'Bank account and IFSC required' });
    }

    const user = await User.findById(req.user._id);

    if (user.walletBalance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
    }

    // Prevent duplicate pending withdrawals
    const existingPending = await Withdrawal.findOne({ sellerId: user._id, status: 'pending' });
    if (existingPending) {
      return res.status(400).json({ success: false, message: 'You already have a pending withdrawal. Wait for it to be processed.' });
    }

    // Freeze balance (deduct)
    user.walletBalance -= amount;
    await user.save();

    const withdrawal = await Withdrawal.create({
      sellerId: user._id,
      amount,
      method,
      upiId,
      bankAccount,
      ifsc,
      status: 'pending'
    });

    res.status(201).json({ success: true, message: 'Withdrawal requested', data: withdrawal });
  } catch (err) { next(err); }
});

// GET /api/v1/withdrawals/my
router.get('/my', authenticate, async (req, res, next) => {
  try {
    const requests = await Withdrawal.find({ sellerId: req.user._id })
      .sort({ requestedAt: -1 });
    res.json({ success: true, data: requests });
  } catch (err) { next(err); }
});

// POST /api/v1/withdrawals/:id/pay (Admin only)
router.post('/:id/pay', authenticate, async (req, res, next) => {
  try {
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const { transactionRef } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id);

    if (!withdrawal || withdrawal.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal or already processed' });
    }

    withdrawal.status = 'completed';
    withdrawal.processedAt = new Date();
    withdrawal.transactionRef = transactionRef;
    withdrawal.adminId = req.user._id;
    await withdrawal.save();

    res.json({ success: true, message: 'Marked as paid', data: withdrawal });
  } catch (err) { next(err); }
});

module.exports = router;
