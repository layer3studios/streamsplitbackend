const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const Listing = require('../models/Listing');
const User = require('../models/User');
const { encryptText } = require('../utils/encryption');

const createListingSchema = Joi.object({
  type: Joi.string().valid('subscription', 'marketplace').default('subscription'),
  platform: Joi.string().required(),
  deliveryMethod: Joi.string().valid('instant', 'manual').required(),
  description: Joi.string().max(300).allow('', null).default(''),

  // --- Subscription ---
  listingSubType: Joi.string().valid('typeA', 'typeB').when('type', {
    is: 'subscription', then: Joi.required(), otherwise: Joi.forbidden()
  }),
  totalSlots: Joi.number().min(2).max(6).when('type', {
    is: 'subscription', then: Joi.required(), otherwise: Joi.forbidden()
  }),
  pricePerSlot: Joi.number().when('listingSubType', {
    is: 'typeA', then: Joi.number().min(10).required(), otherwise: Joi.optional()
  }),
  subscriptionCost: Joi.number().when('listingSubType', {
    is: 'typeB', then: Joi.number().required(), otherwise: Joi.optional()
  }),
  duration: Joi.number().when('listingSubType', {
    is: 'typeA', then: Joi.valid(1, 3, 6, 12).required(), 
    is: 'typeB', then: Joi.valid(1, 3, 6).required(),
    otherwise: Joi.optional()
  }),
  credentialsType: Joi.string().valid('email_password', 'profile_pin', 'family_link').when('type', {
    is: 'subscription', then: Joi.required(), otherwise: Joi.forbidden()
  }),

  // --- Marketplace ---
  category: Joi.string().valid('gift_card', 'gaming_currency', 'game_key', 'ott_voucher', 'other').when('type', {
    is: 'marketplace', then: Joi.required(), otherwise: Joi.forbidden()
  }),
  brand: Joi.string().when('type', {
    is: 'marketplace', then: Joi.optional(), otherwise: Joi.forbidden()
  }),
  faceValue: Joi.number().when('type', {
    is: 'marketplace', then: Joi.required(), otherwise: Joi.forbidden()
  }),
  sellingPrice: Joi.number().when('type', {
    is: 'marketplace', then: Joi.required().custom((value, helpers) => {
      const faceValue = helpers.state.ancestors[0].faceValue;
      if (faceValue !== undefined && value > faceValue) {
        return helpers.message('Selling price must be <= face value');
      }
      return value;
    }), otherwise: Joi.forbidden()
  }),
  quantity: Joi.number().min(1).when('type', {
    is: 'marketplace', then: Joi.required(), otherwise: Joi.forbidden()
  }),
  deliveryTime: Joi.number().valid(1, 2, 6, 12, 24).when('type', {
    is: 'marketplace', then: Joi.any().when('deliveryMethod', {
      is: 'manual', then: Joi.required(), otherwise: Joi.forbidden()
    }), otherwise: Joi.forbidden()
  }),
  proofUrl: Joi.string().uri().optional(),
  inventoryCodes: Joi.array().items(Joi.string()).when('type', {
    is: 'marketplace', then: Joi.any().when('deliveryMethod', {
      is: 'instant', then: Joi.array().items(Joi.string()).min(1).required(), otherwise: Joi.forbidden()
    }), otherwise: Joi.forbidden()
  })
});

// POST /listings
router.post('/', authenticate, validate(createListingSchema), async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);

    // Pre-Check Seller Listing Count
    if (user.sellerPlan === 'free' && user.sellerListingCount >= 3) {
      return res.status(403).json({
        success: false,
        message: 'Upgrade to Pro to add more listings'
      });
    }

    const payload = req.body;
    let listingData = {
      sellerId: user._id,
      type: payload.type,
      platform: payload.platform,
      deliveryMethod: payload.deliveryMethod,
      description: payload.description,
      status: 'pending_review' // Auto-approved logic applied below
    };

    if (payload.type === 'subscription') {
      let calculatedPricePerSlot = payload.pricePerSlot;
      if (payload.listingSubType === 'typeB') {
        calculatedPricePerSlot = Math.ceil(payload.subscriptionCost / payload.totalSlots);
      }

      listingData = {
        ...listingData,
        listingSubType: payload.listingSubType,
        totalSlots: payload.totalSlots,
        pricePerSlot: calculatedPricePerSlot,
        subscriptionCost: payload.listingSubType === 'typeB' ? payload.subscriptionCost : null,
        duration: payload.duration,
        credentialsType: payload.credentialsType
      };
    } else if (payload.type === 'marketplace') {
      let encryptedCodes = [];
      let finalQuantity = payload.quantity;

      if (payload.deliveryMethod === 'instant' && payload.inventoryCodes) {
        finalQuantity = payload.inventoryCodes.length;
        encryptedCodes = payload.inventoryCodes.map(code => encryptText(code));
      }

      listingData = {
        ...listingData,
        category: payload.category,
        brand: payload.brand,
        faceValue: payload.faceValue,
        sellingPrice: payload.sellingPrice,
        quantity: finalQuantity,
        deliveryTime: payload.deliveryTime,
        proofUrl: payload.proofUrl,
        inventoryCodes: encryptedCodes
      };
    }

    const listing = await Listing.create(listingData);

    // Update User's sellerListingCount
    user.sellerListingCount += 1;
    if (user.role === 'buyer') user.role = 'both';
    await user.save();

    // MVP: Auto-approve after 30 seconds
    setTimeout(async () => {
      try {
        const doc = await Listing.findById(listing._id);
        if (doc && doc.status === 'pending_review') {
          doc.status = 'active';
          await doc.save();
          console.log(`[Auto-Approve] Listing ${listing._id} is now ACTIVE`);
        }
      } catch (e) {
        console.error('Error auto-approving listing', e);
      }
    }, 30000);

    res.status(201).json({
      success: true,
      message: 'Listing submitted successfully. Pending review.',
      data: {
        id: listing._id,
        type: listing.type,
        status: listing.status
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /listings (Explore API)
router.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const filter = { status: 'active' };
    
    if (req.query.platform) filter.platform = req.query.platform;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.category) filter.category = req.query.category;

    const listings = await Listing.find(filter)
      .select('-inventoryCodes') // NEVER leak encrypted codes to the frontend during browse!
      .populate('sellerId', 'name avatarUrl isVerified')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await Listing.countDocuments(filter);

    res.json({
      success: true,
      data: listings,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    next(err);
  }
});

// GET /listings/:id
router.get('/:id', async (req, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id)
      .select('-inventoryCodes')
      .populate('sellerId', 'name avatarUrl isVerified');
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });
    res.json({ success: true, data: listing });
  } catch (err) { next(err); }
});

// PUT /listings/:id (Seller Edit)
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const listing = await Listing.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });

    // Allow seller to pause/unpause
    if (req.body.status && ['active', 'paused'].includes(req.body.status)) {
      listing.status = req.body.status;
    }

    // Other edits like description
    if (req.body.description !== undefined) listing.description = req.body.description;
    if (req.body.proofUrl) listing.proofUrl = req.body.proofUrl;

    await listing.save();
    res.json({ success: true, message: 'Listing updated', data: listing });
  } catch (err) { next(err); }
});

// DELETE /listings/:id (Seller Delete)
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const listing = await Listing.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found' });

    // EDGE CASE: Seller deletes listing while active subscription orders exist
    if (listing.type === 'subscription' && listing.filledSlots > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete listing with active subscribers. You may "pause" it instead.' 
      });
    }

    // EDGE CASE: Seller deletes listing while marketplace orders are pending
    if (listing.type === 'marketplace') {
      const Order = require('../models/Order');
      const activeMarketplaceOrders = await Order.countDocuments({
        listingId: listing._id,
        status: { $in: ['pending', 'pending_delivery', 'delivered'] }
      });
      if (activeMarketplaceOrders > 0) {
        return res.status(400).json({ 
          success: false, 
          message: 'Cannot delete listing with active or pending orders. Wait for them to complete.' 
        });
      }
    }

    await Listing.deleteOne({ _id: listing._id });

    // Decrement sellerListingCount
    await User.findByIdAndUpdate(req.user._id, { $inc: { sellerListingCount: -1 } });

    res.json({ success: true, message: 'Listing deleted successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
