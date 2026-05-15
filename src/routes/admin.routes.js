const router = require('express').Router();
const User = require('../models/User');
const Order = require('../models/Order');
const Dispute = require('../models/Dispute');
const Withdrawal = require('../models/WithdrawalRequest');
const Listing = require('../models/Listing');
const { authenticate } = require('../middleware/auth');

// Middleware to ensure user is admin
const isAdmin = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user || !['admin', 'super_admin'].includes(user.role)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    next();
  } catch (err) { next(err); }
};

router.use(authenticate, isAdmin);

// ─── DASHBOARD ──────────────────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
    const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0,0,0,0);

    const [totalUsers, activeListings, pendingWithdrawals, openDisputes, newUsersToday, pendingListings] = await Promise.all([
      User.countDocuments(),
      Listing.countDocuments({ status: 'active' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Dispute.countDocuments({ status: 'open' }),
      User.countDocuments({ createdAt: { $gte: todayStart } }),
      Listing.countDocuments({ status: 'pending_review' })
    ]);

    // Revenue aggregation
    const revenueAgg = await Order.aggregate([
      { $match: { status: { $in: ['active', 'completed', 'delivered'] } } },
      { $group: {
        _id: null,
        total: { $sum: '$amount' },
        today: { $sum: { $cond: [{ $gte: ['$createdAt', todayStart] }, '$amount', 0] } },
        thisWeek: { $sum: { $cond: [{ $gte: ['$createdAt', weekStart] }, '$amount', 0] } },
        thisMonth: { $sum: { $cond: [{ $gte: ['$createdAt', monthStart] }, '$amount', 0] } },
        activeOrdersCount: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }
      }}
    ]);
    const rev = revenueAgg[0] || { total: 0, today: 0, thisWeek: 0, thisMonth: 0, activeOrdersCount: 0 };

    res.json({ success: true, data: {
      totalUsers, newUsersToday, activeListings, pendingListings,
      pendingWithdrawals, openDisputes,
      activeOrdersCount: rev.activeOrdersCount,
      revenue: { today: rev.today, thisWeek: rev.thisWeek, thisMonth: rev.thisMonth, total: rev.total }
    }});
  } catch (err) { next(err); }
});

// ─── USERS ──────────────────────────────────────────────────
router.get('/users', async (req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ success: true, data: users });
  } catch (err) { next(err); }
});

router.put('/users/:id', async (req, res, next) => {
  try {
    const { isBanned } = req.body;
    const user = await User.findByIdAndUpdate(req.params.id, { isBanned }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: user, message: isBanned ? 'User banned' : 'User unbanned' });
  } catch (err) { next(err); }
});

// ─── LISTINGS ───────────────────────────────────────────────
router.get('/listings', async (req, res, next) => {
  try {
    const listings = await Listing.find().sort({ createdAt: -1 });
    res.json({ success: true, data: listings });
  } catch (err) { next(err); }
});

router.put('/listings/:id', async (req, res, next) => {
  try {
    const { status } = req.body; // e.g. 'active', 'rejected'
    const listing = await Listing.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });
    res.json({ success: true, data: listing });
  } catch (err) { next(err); }
});

// ─── ORDERS ─────────────────────────────────────────────────
router.get('/orders', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.platform) filter.platform = req.query.platform;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.createdAt.$lte = new Date(req.query.to);
    }
    const orders = await Order.find(filter)
      .populate('buyerId', 'name phone')
      .populate('sellerId', 'name phone')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: orders });
  } catch (err) { next(err); }
});

// PUT /admin/orders/:id — Force-refund or force-complete any order
router.put('/orders/:id', async (req, res, next) => {
  try {
    const { action } = req.body; // 'force_refund' or 'force_complete'
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (action === 'force_refund') {
      order.status = 'refunded';
      // Restore slots/quantity
      const listing = await Listing.findById(order.listingId);
      if (listing) {
        if (order.type === 'subscription') listing.filledSlots = Math.max(0, listing.filledSlots - 1);
        else if (order.type === 'marketplace') listing.quantity += 1;
        await listing.save();
      }
      order.escrowPending = 0;
      await order.save();
    } else if (action === 'force_complete') {
      // Release remaining escrow to seller
      const seller = await User.findById(order.sellerId);
      if (seller && order.escrowPending > 0) {
        seller.walletBalance = (seller.walletBalance || 0) + order.escrowPending;
        await seller.save();
      }
      order.escrowReleased = (order.escrowReleased || 0) + (order.escrowPending || 0);
      order.escrowPending = 0;
      order.status = 'completed';
      await order.save();
    } else {
      return res.status(400).json({ success: false, message: 'action must be force_refund or force_complete' });
    }

    res.json({ success: true, message: `Order ${action} successful`, data: order });
  } catch (err) { next(err); }
});

// ─── WITHDRAWALS ────────────────────────────────────────────
router.get('/withdrawals', async (req, res, next) => {
  try {
    const withdrawals = await Withdrawal.find({ status: 'pending' }).populate('sellerId', 'name phone').sort({ requestedAt: -1 });
    res.json({ success: true, data: withdrawals });
  } catch (err) { next(err); }
});

router.put('/withdrawals/:id', async (req, res, next) => {
  try {
    const { status, transactionRef } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Withdrawal not found' });

    withdrawal.status = status;
    withdrawal.transactionRef = transactionRef;
    withdrawal.adminId = req.user._id;
    if (status === 'completed') withdrawal.processedAt = new Date();
    
    // If rejected, refund the wallet
    if (status === 'failed') {
      const seller = await User.findById(withdrawal.sellerId);
      if (seller) {
        seller.walletBalance += withdrawal.amount;
        await seller.save();
      }
    }

    await withdrawal.save();
    res.json({ success: true, data: withdrawal });
  } catch (err) { next(err); }
});

// ─── DISPUTES ───────────────────────────────────────────────
router.get('/disputes', async (req, res, next) => {
  try {
    const disputes = await Dispute.find().populate('orderId').populate('raisedBy', 'name phone').sort({ createdAt: -1 });
    res.json({ success: true, data: disputes });
  } catch (err) { next(err); }
});

router.put('/disputes/:id', async (req, res, next) => {
  try {
    const { status, resolution, adminNote, partialAmount } = req.body;
    const dispute = await Dispute.findById(req.params.id);
    if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });

    dispute.status = status || dispute.status;
    dispute.adminNote = adminNote || dispute.adminNote;
    dispute.adminId = req.user._id;
    
    if (resolution) {
      dispute.resolution = resolution;
      dispute.resolvedAt = new Date();
      dispute.status = 'resolved';

      const order = await Order.findById(dispute.orderId);
      if (order && order.status === 'disputed') {
        const EscrowTransaction = require('../models/EscrowTransaction');

        if (resolution === 'refunded') {
          // Full refund to buyer — seller keeps what was already released
          order.status = 'refunded';
          order.escrowPending = 0;

          // Restore slot/quantity on the listing
          const listing = await Listing.findById(order.listingId);
          if (listing) {
            if (order.type === 'subscription') {
              listing.filledSlots = Math.max(0, listing.filledSlots - 1);
            } else if (order.type === 'marketplace') {
              listing.quantity += 1;
            }
            await listing.save();
          }

          await EscrowTransaction.create({
            orderId: order._id,
            amountReleased: 0,
            releaseDate: new Date(),
            sellerWalletBefore: 0,
            sellerWalletAfter: 0,
            type: 'refund'
          });

        } else if (resolution === 'released') {
          // Seller wins — release remaining escrow to seller
          const seller = await User.findById(order.sellerId);
          if (seller) {
            const walletBefore = seller.walletBalance || 0;
            seller.walletBalance = walletBefore + order.escrowPending;
            await seller.save();

            await EscrowTransaction.create({
              orderId: order._id,
              amountReleased: order.escrowPending,
              releaseDate: new Date(),
              sellerWalletBefore: walletBefore,
              sellerWalletAfter: seller.walletBalance,
              type: 'dispute_release'
            });
          }
          order.escrowReleased += order.escrowPending;
          order.escrowPending = 0;
          order.status = 'completed';

        } else if (resolution === 'partial' && partialAmount > 0) {
          // Partial: release partialAmount to seller, refund the rest to buyer
          const releaseToSeller = Math.min(partialAmount, order.escrowPending);
          const refundToBuyer = order.escrowPending - releaseToSeller;

          const seller = await User.findById(order.sellerId);
          if (seller) {
            const walletBefore = seller.walletBalance || 0;
            seller.walletBalance = walletBefore + releaseToSeller;
            await seller.save();

            await EscrowTransaction.create({
              orderId: order._id,
              amountReleased: releaseToSeller,
              releaseDate: new Date(),
              sellerWalletBefore: walletBefore,
              sellerWalletAfter: seller.walletBalance,
              type: 'dispute_release'
            });
          }

          order.escrowReleased += releaseToSeller;
          order.escrowPending = 0;
          order.status = 'completed';
          // In real implementation: issue Razorpay refund for refundToBuyer amount
        }

        await order.save();
      }
    }

    await dispute.save();
    res.json({ success: true, data: dispute });
  } catch (err) { next(err); }
});

module.exports = router;
