const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const { protect } = require('../middleware/auth');

// GET /api/notifications
// Supports: ?page=1&limit=20&eventCategory=LOANS|PAYMENTS|SECURITY|KYC|CHIT_FUNDS
// Returns paginated notifications + unread count
router.get('/', protect, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;
    const { eventCategory } = req.query;

    // Map tab filter to canonical event types
    const categoryMap = {
      LOANS: ['LOAN_CREATED', 'LOAN_RECEIVED', 'AGREEMENT_READY', 'AGREEMENT_ACCEPTED', 'LOAN_ACTIVATED', 'LOAN_COMPLETED', 'LOAN_CLOSED'],
      PAYMENTS: ['PAYMENT_RECEIVED', 'PAYMENT_FAILED'],
      SECURITY: ['MPIN_CREATED', 'EMAIL_VERIFIED', 'ACCOUNT_CREATED'],
      KYC: ['KYC_UPDATE'],
      CHIT_FUNDS: ['CHIT_INVITE', 'CHIT_JOINED', 'CHIT_CONTRIBUTION_DUE', 'AUCTION_OPENED', 'AUCTION_CLOSED', 'CHIT_PAYOUT'],
    };

    const query = { userId: req.user.id };
    if (eventCategory && categoryMap[eventCategory]) {
      query.eventType = { $in: categoryMap[eventCategory] };
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Notification.countDocuments(query),
      Notification.countDocuments({ userId: req.user.id, isRead: false }),
    ]);

    res.json({
      success: true,
      notifications,
      unreadCount,
      pagination: { page, limit, total, hasMore: skip + notifications.length < total }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', protect, async (req, res) => {
  try {
    const count = await Notification.countDocuments({ userId: req.user.id, isRead: false });
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/notifications/:id/read — mark single as read
router.put('/:id/read', protect, async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { isRead: true, readAt: new Date() },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    res.json({ success: true, notification });
  } catch (error) {
    console.error('Error marking notification read:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/notifications/read-all — mark all as read
router.put('/read-all', protect, async (req, res) => {
  try {
    const now = new Date();
    await Notification.updateMany(
      { userId: req.user.id, isRead: false },
      { isRead: true, readAt: now }
    );
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all notifications read:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
