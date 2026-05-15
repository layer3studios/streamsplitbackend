const router = require('express').Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const Order = require('../models/Order');
const Listing = require('../models/Listing');
const User = require('../models/User');
const Dispute = require('../models/Dispute');
const { authenticate } = require('../middleware/auth');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─── POST /api/v1/orders/checkout ────────────────────────────
router.post('/checkout', authenticate, async (req, res, next) => {
  try {
    const { listingId } = req.body;
    const listing = await Listing.findById(listingId);
    
    if (!listing || listing.status !== 'active') {
      return res.status(404).json({ success: false, message: 'Listing not found or not active' });
    }
    
    // Quantity/Slots check
    if (listing.type === 'marketplace' && listing.quantity <= 0) {
      return res.status(400).json({ success: false, message: 'Out of stock' });
    } else if (listing.type === 'subscription' && listing.filledSlots >= listing.totalSlots) {
      return res.status(400).json({ success: false, message: 'No slots available' });
    }

    if (listing.sellerId.toString() === req.user._id.toString()) {
      return res.status(400).json({ success: false, message: 'Cannot buy your own listing' });
    }

    const amount = listing.type === 'marketplace' ? listing.sellingPrice : listing.pricePerSlot; // in rupees
    
    // Create Razorpay Order
    const rpOrder = await razorpay.orders.create({
      amount: Math.round(amount * 100), // paise
      currency: 'INR',
      notes: {
        listingId: listing._id.toString(),
        buyerId: req.user._id.toString(),
        type: listing.type
      },
    });

    let orderData = {
      type: listing.type,
      buyerId: req.user._id,
      sellerId: listing.sellerId,
      listingId: listing._id,
      platform: listing.platform,
      amount: amount,
      status: 'pending',
      pgOrderId: rpOrder.id,
    };

    if (listing.type === 'subscription') {
      const durationDays = listing.duration * 30; // approx
      orderData = {
        ...orderData,
        duration: durationDays,
        escrowAmount: amount,
        escrowPending: amount,
        escrowReleased: 0,
      };
    } else if (listing.type === 'marketplace') {
      orderData = {
        ...orderData,
        category: listing.category,
        faceValue: listing.faceValue,
        deliveryMethod: listing.deliveryMethod,
      };
    }

    const order = await Order.create(orderData);

    res.json({
      success: true,
      data: {
        order,
        razorpay: {
          order_id: rpOrder.id,
          amount: rpOrder.amount,
          currency: rpOrder.currency,
          key_id: process.env.RAZORPAY_KEY_ID,
        }
      }
    });
  } catch (err) { next(err); }
});

// ─── GET /api/v1/orders/my — Buyer's order history ───────────
router.get('/my', authenticate, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    // 1. Old marketplace orders
    const orderFilter = { buyerId: req.user._id };
    if (req.query.status) orderFilter.status = req.query.status;
    if (req.query.type) orderFilter.type = req.query.type;
    const orders = await Order.find(orderFilter)
      .populate('listingId', 'platform type category brand')
      .populate('sellerId', 'name avatarUrl')
      .sort({ createdAt: -1 })
      .limit(limit);

    // 2. Group join transactions (the main purchase type)
    const GroupTransaction = require('../models/GroupTransaction');
    const Group = require('../models/Group');
    const gtxns = await GroupTransaction.find({ buyer_id: req.user._id })
      .populate('group_id', 'name brand_id share_price')
      .populate('owner_id', 'name')
      .sort({ createdAt: -1 })
      .limit(limit);

    // Populate brand names for group transactions
    const brandIds = gtxns.map(t => t.group_id?.brand_id).filter(Boolean);
    const Brand = require('../models/Brand');
    const brands = await Brand.find({ _id: { $in: brandIds } }).select('name logo_url');
    const brandMap = {};
    brands.forEach(b => { brandMap[b._id.toString()] = b; });

    // 3. Merge into unified format
    const unified = [];

    // Marketplace orders
    orders.forEach(o => {
      unified.push({
        _id: o._id,
        type: 'marketplace',
        order_number: o.pgOrderId || `ORD-${o._id.toString().slice(-6).toUpperCase()}`,
        items: [{ plan_snapshot: { name: o.listingId?.platform || 'Item', brand_name: o.listingId?.brand || '' } }],
        total: o.amount || 0,
        status: o.status,
        createdAt: o.createdAt,
      });
    });

    // Group join transactions
    gtxns.forEach(t => {
      const group = t.group_id;
      const brand = group?.brand_id ? brandMap[group.brand_id.toString()] : null;
      unified.push({
        _id: t._id,
        type: 'group_join',
        order_number: `GRP-${t._id.toString().slice(-6).toUpperCase()}`,
        items: [{ plan_snapshot: { name: group?.name || 'Group Join', brand_name: brand?.name || '' } }],
        total: t.gross || 0,
        status: t.status === 'paid' ? 'fulfilled' : t.status,
        createdAt: t.createdAt,
      });
    });

    // Sort by date desc
    unified.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const paged = unified.slice(0, limit);

    res.json({
      success: true,
      data: paged,
      pagination: { page, limit, total: unified.length, pages: Math.ceil(unified.length / limit) }
    });
  } catch (err) { next(err); }
});

// ─── GET /api/v1/orders/seller — Seller's incoming orders ────
router.get('/seller', authenticate, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const filter = { sellerId: req.user._id };

    if (req.query.status) filter.status = req.query.status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('buyerId', 'name avatarUrl')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Order.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) { next(err); }
});

// ─── GET /api/v1/orders/:id ─────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('sellerId', 'name avatarUrl')
      .populate('buyerId', 'name avatarUrl');
      
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    
    // Security: Only buyer or seller can view
    if (order.buyerId._id.toString() !== req.user._id.toString() && 
        order.sellerId._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Security: Only buyer sees credentials/deliveredCode
    const orderObj = order.toObject();
    if (order.sellerId._id.toString() === req.user._id.toString()) {
      delete orderObj.credentials;
      delete orderObj.deliveredCode;
    }

    res.json({ success: true, data: orderObj });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/orders/:id/credentials — Seller delivers creds for subscription ─
router.post('/:id/credentials', authenticate, async (req, res, next) => {
  try {
    const { email, password, profileName } = req.body;
    if (!email && !password) {
      return res.status(400).json({ success: false, message: 'At least email or password is required' });
    }

    const order = await Order.findOne({ _id: req.params.id, sellerId: req.user._id, type: 'subscription' });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Order is not active' });
    }

    order.credentials = { email, password, profileName };
    await order.save();

    res.json({ success: true, message: 'Credentials delivered to buyer', data: { orderId: order._id } });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/orders/:id/dispute — Creates Dispute record ─
router.post('/:id/dispute', authenticate, async (req, res, next) => {
  try {
    const { issueType, description, proofUrl } = req.body;

    if (!issueType || !description) {
      return res.status(400).json({ success: false, message: 'issueType and description are required' });
    }

    const order = await Order.findOne({ _id: req.params.id, buyerId: req.user._id });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    
    if (!['active', 'delivered'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Only active or delivered orders can be disputed' });
    }

    // Prevent duplicate disputes
    const existingDispute = await Dispute.findOne({ orderId: order._id, status: { $in: ['open', 'seller_responded'] } });
    if (existingDispute) {
      return res.status(400).json({ success: false, message: 'A dispute is already open for this order' });
    }

    // Edge Case 7: Marketplace invalid code -> Auto Refund (no admin needed)
    if (order.type === 'marketplace' && issueType === 'invalid_code') {
      order.status = 'refunded';
      await order.save();

      await Dispute.create({
        orderId: order._id,
        raisedBy: req.user._id,
        issueType,
        description,
        proofUrl,
        status: 'resolved',
        resolution: 'refunded',
        resolvedAt: new Date(),
        adminNote: 'Auto-refund: invalid marketplace code'
      });

      return res.json({
        success: true,
        message: 'Invalid code reported. Auto-refund processed.',
        data: { orderId: order._id, status: 'refunded' }
      });
    }

    // Normal dispute flow
    order.status = 'disputed';
    await order.save();

    const dispute = await Dispute.create({
      orderId: order._id,
      raisedBy: req.user._id,
      issueType,
      description,
      proofUrl
    });

    res.json({
      success: true,
      message: 'Dispute raised successfully. Escrow releases have been paused.',
      data: dispute
    });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/orders/:id/dispute/respond — Seller responds to dispute ─
router.post('/:id/dispute/respond', authenticate, async (req, res, next) => {
  try {
    const { sellerResponse } = req.body;
    if (!sellerResponse) {
      return res.status(400).json({ success: false, message: 'Response text is required' });
    }

    const order = await Order.findOne({ _id: req.params.id, sellerId: req.user._id, status: 'disputed' });
    if (!order) return res.status(404).json({ success: false, message: 'Disputed order not found' });

    const dispute = await Dispute.findOne({ orderId: order._id, status: 'open' });
    if (!dispute) return res.status(404).json({ success: false, message: 'No open dispute found' });

    dispute.sellerResponse = sellerResponse;
    dispute.status = 'seller_responded';
    await dispute.save();

    res.json({ success: true, message: 'Response submitted. Admin will review.', data: dispute });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/orders/:id/deliver — Marketplace Seller manual delivery ─
router.post('/:id/deliver', authenticate, async (req, res, next) => {
  try {
    const { deliveredCode } = req.body;
    if (!deliveredCode) return res.status(400).json({ success: false, message: 'Delivered code required' });

    const order = await Order.findOne({ _id: req.params.id, sellerId: req.user._id, type: 'marketplace' });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.status !== 'pending_delivery') {
      return res.status(400).json({ success: false, message: 'Order is not pending delivery' });
    }

    const now = new Date();
    order.status = 'delivered';
    order.deliveredCode = deliveredCode;
    order.deliveredAt = now;
    
    const deadline = new Date(now);
    deadline.setHours(deadline.getHours() + 24);
    order.confirmDeadline = deadline;
    order.autoReleaseAt = deadline;

    await order.save();

    res.json({ success: true, message: 'Item delivered successfully', data: order });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/orders/:id/confirm-receipt — Buyer confirms marketplace item ─
router.post('/:id/confirm-receipt', authenticate, async (req, res, next) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, buyerId: req.user._id, type: 'marketplace' });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'Order is not delivered yet' });
    }

    // Release funds immediately
    const seller = await User.findById(order.sellerId);
    if (seller) {
      seller.walletBalance = (seller.walletBalance || 0) + order.amount;
      await seller.save();
    }

    order.status = 'completed';
    await order.save();

    res.json({ success: true, message: 'Receipt confirmed. Funds released to seller.' });
  } catch (err) { next(err); }
});

module.exports = router;
