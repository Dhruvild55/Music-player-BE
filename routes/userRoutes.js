const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { protect } = require('../middleware/authMiddleware');

// Profile routes
router.get('/:userId/profile', userController.getUserProfile);
router.get('/:userId/stats', userController.getUserStats);
router.patch('/profile', protect, userController.updateProfile);

// Follow routes
router.post('/:userId/follow', protect, userController.followUser);
router.delete('/:userId/unfollow', protect, userController.unfollowUser);
router.get('/:userId/followers', userController.getFollowers);
router.get('/:userId/following', userController.getFollowing);
router.get('/friends/activity', protect, userController.getFriendsActivity);

module.exports = router;
