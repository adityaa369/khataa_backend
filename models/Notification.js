const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: String,
    ref: 'User',
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  body: {
    type: String,
    required: true,
  },
  // Canonical event type from NotificationEvents.js (e.g., PAYMENT_RECEIVED)
  eventType: {
    type: String,
    default: 'general',
  },
  // Legacy type field kept for backwards compat (e.g., 'LOAN_TRANSACTION')
  type: {
    type: String,
    default: 'general',
  },
  // Reference to the business entity (e.g., 'LOAN', 'USER')
  referenceType: {
    type: String,
  },
  // The ID of the referenced entity (e.g., loan._id)
  referenceId: {
    type: String,
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  // Timestamp when it was read (for sorting/display)
  readAt: {
    type: Date,
  },
  // Safe non-sensitive payload for deep-link resolution
  data: {
    type: Object,
    default: {},
  },
}, { timestamps: true });

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, isRead: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
