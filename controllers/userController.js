const User = require('../models/User');
const Room = require('../models/Room');

// Get user profile with stats
exports.getUserProfile = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId)
            .select('-password')
            .populate('createdRooms');

        if (!user) {
            return res.status(404).json({
                status: 'fail',
                message: 'User not found'
            });
        }

        // Calculate stats
        const totalListeningTime = user.listeningHistory.reduce((acc, session) => acc + (session.duration || 0), 0);
        const totalListeningHours = Math.floor(totalListeningTime / 3600);

        // Get most played rooms
        const roomCounts = {};
        user.listeningHistory.forEach(session => {
            roomCounts[session.roomId] = (roomCounts[session.roomId] || 0) + 1;
        });
        const mostPlayed = Object.entries(roomCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([roomId, count]) => ({ roomId, playCount: count }));

        res.status(200).json({
            status: 'success',
            data: {
                user: {
                    _id: user._id,
                    username: user.username,
                    email: user.email,
                    avatarColor: user.avatarColor,
                    bio: user.bio,
                    followersCount: user.followers.length,
                    followingCount: user.following.length,
                    createdRoomsCount: user.createdRooms?.length || 0,
                    totalListeningHours,
                    mostPlayed,
                    recentHistory: user.listeningHistory.slice(-10).reverse()
                }
            }
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
};

// Update own profile
exports.updateProfile = async (req, res) => {
    try {
        const { bio, avatarColor } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.user.id,
            { bio, avatarColor },
            { new: true, runValidators: true }
        ).select('-password');

        res.status(200).json({
            status: 'success',
            data: { user: updatedUser }
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
};

// Get user stats
exports.getUserStats = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) {
            return res.status(404).json({
                status: 'fail',
                message: 'User not found'
            });
        }

        const createdRooms = await Room.find({ owner: user._id });
        const totalListeningTime = user.listeningHistory.reduce((acc, session) => acc + (session.duration || 0), 0);

        res.status(200).json({
            status: 'success',
            data: {
                stats: {
                    totalListeningHours: Math.floor(totalListeningTime / 3600),
                    roomsCreated: createdRooms.length,
                    followersCount: user.followers.length,
                    followingCount: user.following.length,
                    totalSessions: user.listeningHistory.length
                }
            }
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
};

// Follow a user
exports.followUser = async (req, res) => {
    try {
        const userToFollow = await User.findById(req.params.userId);
        const currentUser = await User.findById(req.user.id);

        if (!userToFollow) {
            return res.status(404).json({
                status: 'fail',
                message: 'User not found'
            });
        }

        if (req.params.userId === req.user.id) {
            return res.status(400).json({
                status: 'fail',
                message: 'You cannot follow yourself'
            });
        }

        // Check if already following
        if (currentUser.following.includes(req.params.userId)) {
            return res.status(400).json({
                status: 'fail',
                message: 'Already following this user'
            });
        }

        // Add to following and followers
        currentUser.following.push(req.params.userId);
        userToFollow.followers.push(req.user.id);

        await currentUser.save();
        await userToFollow.save();

        res.status(200).json({
            status: 'success',
            message: 'User followed successfully'
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
};

// Unfollow a user
exports.unfollowUser = async (req, res) => {
    try {
        const userToUnfollow = await User.findById(req.params.userId);
        const currentUser = await User.findById(req.user.id);

        if (!userToUnfollow) {
            return res.status(404).json({
                status: 'fail',
                message: 'User not found'
            });
        }

        // Remove from following and followers
        currentUser.following = currentUser.following.filter(id => id.toString() !== req.params.userId);
        userToUnfollow.followers = userToUnfollow.followers.filter(id => id.toString() !== req.user.id);

        await currentUser.save();
        await userToUnfollow.save();

        res.status(200).json({
            status: 'success',
            message: 'User unfollowed successfully'
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
};

// Get followers list
exports.getFollowers = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId)
            .populate('followers', 'username avatarColor bio');

        if (!user) {
            return res.status(404).json({
                status: 'fail',
                message: 'User not found'
            });
        }

        res.status(200).json({
            status: 'success',
            data: { followers: user.followers }
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
};

// Get following list
exports.getFollowing = async (req, res) => {
    try {
        const user = await User.findById(req.params.userId)
            .populate('following', 'username avatarColor bio');

        if (!user) {
            return res.status(404).json({
                status: 'fail',
                message: 'User not found'
            });
        }

        res.status(200).json({
            status: 'success',
            data: { following: user.following }
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
};

// Get friends activity
exports.getFriendsActivity = async (req, res) => {
    try {
        const currentUser = await User.findById(req.user.id);
        if (!currentUser) {
            return res.status(404).json({
                status: 'fail',
                message: 'User not found'
            });
        }

        const following = await User.find({ _id: { $in: currentUser.following } })
            .select('username avatarColor')
            .limit(20);

        // Get active rooms to check who's live
        const activeRooms = await Room.find({ isPublic: true });

        // Add live status to friends
        const friendsWithStatus = following.map(friend => {
            const liveRoom = activeRooms.find(room =>
                room.creatorId && String(room.creatorId) === String(friend._id)
            );

            return {
                _id: friend._id,
                username: friend.username,
                avatarColor: friend.avatarColor,
                isLive: !!liveRoom,
                currentRoom: liveRoom ? {
                    roomId: liveRoom.roomId,
                    name: liveRoom.name
                } : null
            };
        });

        res.status(200).json({
            status: 'success',
            data: { friends: friendsWithStatus }
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message
        });
    }
};
