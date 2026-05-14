const router = require('express').Router();
const Plan = require('../models/Plan');
const Group = require('../models/Group');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.brand_id) filter.brand_id = req.query.brand_id;
    if (req.query.include_inactive !== 'true') filter.is_active = true;

    const plans = await Plan.find(filter)
      .populate('brand_id', 'name slug logo_url')
      .populate('group_id', 'name member_count share_limit status invite_code duration_days')
      .sort({ price: 1 });

    const data = plans.map((plan) => {
      const obj = plan.toObject();
      if (obj.group_id && typeof obj.group_id === 'object') {
        const g = obj.group_id;
        const seatsLeft = Math.max(g.share_limit - g.member_count, 0);
        obj.group_info = {
          group_id: g._id,
          name: g.name,
          seats_total: g.share_limit,
          seats_filled: g.member_count,
          seats_left: seatsLeft,
          is_full: seatsLeft === 0,
          status: g.status,
          invite_code: g.invite_code,
        };
        obj.group_id = g._id; // flatten back to id
      }
      return obj;
    });

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ─── Admin: Create plan ──
router.post('/', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const plan = await Plan.create(req.body);
    res.status(201).json({ success: true, data: plan });
  } catch (err) { next(err); }
});

// ─── Admin: Link plan to a group ──
router.patch('/:id/link-group', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const { group_id } = req.body; // null to unlink
    if (group_id) {
      const group = await Group.findById(group_id);
      if (!group) return res.status(404).json({ success: false, message: 'Group not found' });
    }
    const plan = await Plan.findByIdAndUpdate(req.params.id, { group_id: group_id || null }, { new: true })
      .populate('brand_id', 'name slug logo_url');
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, data: plan });
  } catch (err) { next(err); }
});

// ─── Admin: Update plan fields ──
router.patch('/:id', authenticate, requireRole('admin', 'super_admin'), async (req, res, next) => {
  try {
    const allowed = ['name', 'description', 'price', 'original_price', 'validity_days', 'stock', 'is_active', 'group_id'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const plan = await Plan.findByIdAndUpdate(req.params.id, updates, { new: true })
      .populate('brand_id', 'name slug logo_url');
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    res.json({ success: true, data: plan });
  } catch (err) { next(err); }
});

module.exports = router;
