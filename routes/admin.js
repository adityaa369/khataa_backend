const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const adminController = require('../controllers/admin');

router.use(protect, adminOnly); // All admin routes require auth + admin role

router.get('/stats', adminController.getStats);
router.get('/users', adminController.getUsers);
router.get('/users/:id', adminController.getUserDetail);
router.put('/users/:id/suspend', adminController.toggleSuspend);
router.put('/users/:id/role', adminController.setAdminRole);
router.get('/loans', adminController.getLoans);
router.get('/chit-funds', adminController.getChitFunds);

module.exports = router;
