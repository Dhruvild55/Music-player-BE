const Room = require('../models/Room');
const User = require('../models/User');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Helper function to check if user has DJ permissions
const hasDJPermission = (room, userId) => {
    if (!room) return false;
    // Creator always has permission
    if (String(room.creatorId) === String(userId)) return true;
    // Check if in djPermissions array
    if (room.djPermissions && room.djPermissions.includes(userId)) return true;
    return false;
};

// In-memory store for live state (listeners, skipVotes)
const rooms = {};

const broadcastRooms = async (io) => {
    try {
        const publicRooms = await Room.find({ isPublic: true }).lean();
        const roomsWithStats = publicRooms.map(r => ({
            id: r.roomId,
            name: r.name,
            userCount: rooms[r.roomId]?.users ? Object.keys(rooms[r.roomId].users).length : 0,
            currentSong: r.currentSong,
            tags: r.tags || [],
            description: r.description || ""
        })).sort((a, b) => b.userCount - a.userCount);

        io.emit('update_active_rooms', roomsWithStats);
    } catch (err) {
        console.error('Error broadcasting rooms:', err);
    }
};

// Initialize Rooms from DB on startup
const initRooms = async () => {
    try {
        const dbRooms = await Room.find();
        dbRooms.forEach(room => {
            if (!rooms[room.roomId]) {
                rooms[room.roomId] = {
                    id: room.roomId,
                    users: {},
                    skipVotes: new Set()
                };
            }
        });
        console.log(`Initialized ${dbRooms.length} rooms from database`);
    } catch (err) {
        console.error('Error initializing rooms:', err);
    }
};

const initializeSocket = (io) => {
    initRooms();

    io.on('connection', (socket) => {
        console.log('A user connected:', socket.id);

        // Send initial list of rooms
        broadcastRooms(io);

        socket.on('get_active_rooms', () => {
            broadcastRooms(io);
        });

        socket.on('create_room', async ({ roomId, name, userId, guestId, tags, description }) => {
            try {
                let room = await Room.findOne({ roomId });
                if (!room) {
                    const roomData = {
                        roomId,
                        name: name || roomId,
                        isPublic: true,
                        owner: userId,
                        creatorId: userId || guestId,
                        tags: tags || [],
                        description: description || ""
                    };

                    room = await Room.create(roomData);
                    console.log(`[Create] Room created: ${room.roomId}`);
                    
                    // Emit room_created back to creator
                    socket.emit('room_created', { roomId: room.roomId });

                    if (!rooms[roomId]) {
                        rooms[roomId] = {
                            id: roomId,
                            users: {},
                            skipVotes: new Set()
                        };
                    }
                    console.log(`Room created with tags: ${tags}`);
                }
                broadcastRooms(io);
            } catch (err) {
                console.error('Error creating room:', err);
                socket.emit('error', { message: 'Failed to create room' });
            }
        });

        socket.on('join_room', async ({ roomId, userProfile, guestId, password, inviteCode }) => {
            const effectiveUserId = userProfile?.userId || guestId;
            console.log(`User ${userProfile?.name} (ID: ${effectiveUserId}) attempting to join room: ${roomId}`);

            try {
                // Fetch room from DB
                let roomData = await Room.findOne({ roomId });
                // fallback normalized
                if (!roomData) roomData = await Room.findOne({ roomId: roomId ? String(roomId).toLowerCase() : roomId });

                if (!roomData) {
                    console.log(`[DB] Room not found, attempting to create: ${roomId}`);
                    try {
                        roomData = await Room.create({
                            roomId: roomId.toLowerCase(),
                            name: roomId,
                            isPublic: true,
                            owner: userProfile?.userId || null,
                            creatorId: effectiveUserId
                        });
                        console.log(`[DB] Room created successfully in DB: ${roomData.roomId} with creator: ${effectiveUserId}`);
                    } catch (dbErr) {
                        console.error(`[DB ERROR] Failed to create room ${roomId}:`, dbErr.message);
                    }
                } else {
                    console.log(`[DB] Found existing room: ${roomData.roomId}`);
                    // Fallback for missing creator info on old rooms (for development)
                    if (!roomData.creatorId) {
                        console.log(`[DB] Setting missing creatorId for existing room: ${roomId}`);
                        roomData.creatorId = effectiveUserId;
                        if (userProfile?.userId) roomData.owner = userProfile.userId;
                        await Room.findOneAndUpdate({ roomId: roomData.roomId }, { creatorId: effectiveUserId, owner: roomData.owner });
                    }
                }

                if (!rooms[roomId]) {
                    rooms[roomId] = {
                        id: roomId,
                        users: {},
                        skipVotes: new Set()
                    };
                }

                // Now join the socket after validation
                socket.join(roomId);

                rooms[roomId].users[socket.id] = {
                    id: socket.id,
                    name: userProfile?.name || `User_${socket.id.substring(0, 4)}`,
                    color: userProfile?.color || '#3b82f6',
                    userId: userProfile?.userId || null
                };

                // Notify followers if this user is a DJ (room creator)
                if (roomData && userProfile?.userId && String(roomData.creatorId) === String(userProfile.userId)) {
                    console.log(`DJ ${userProfile.name} (${userProfile.userId}) joined their room ${roomId}`);
                    // Emit to all connected clients - they'll filter based on who they follow
                    io.emit('dj_went_live', {
                        djId: userProfile.userId,
                        djName: userProfile.name,
                        roomId: roomId,
                        roomName: roomData.name
                    });
                    console.log(`Broadcasted dj_went_live event for ${userProfile.name}`);
                }

                // Send existing room state to the new user
                const state = {
                    id: roomData.roomId,
                    name: roomData.name,
                    queue: roomData.queue || [],
                    currentSong: roomData.currentSong || null,
                    isPlaying: roomData.isPlaying || false,
                    currentTime: roomData.currentTime || 0,
                    owner: roomData.owner,
                    creatorId: roomData.creatorId,
                    djPermissions: roomData.djPermissions || [],
                    songRequests: roomData.songRequests || [],
                    users: Object.values(rooms[roomId].users)
                };

                console.log(`Sending state to user ${socket.id} for room ${roomId}`);
                socket.emit('receive_room_state', state);

                // Notify others
                io.to(roomId).emit('update_listeners', Object.values(rooms[roomId].users));
                broadcastRooms(io);
            } catch (err) {
                console.error('Error joining room:', err);
            }
        });

        socket.on('add_to_queue', async ({ roomId, song }) => {
            try {
                const roomData = await Room.findOne({ roomId });
                if (!roomData) return;

                // Check if song already exists in queue or is current
                const isDuplicate = roomData.queue.some(s => s.id === song.id) ||
                    (roomData.currentSong && roomData.currentSong.id === song.id);

                if (isDuplicate) {
                    console.log(`[Queue] Blocked duplicate song: ${song.title}`);
                    return socket.emit('queue_feedback', { type: 'error', message: 'Signal already in sequence' });
                }

                const room = await Room.findOneAndUpdate(
                    { roomId },
                    { $push: { queue: song } },
                    { new: true }
                );

                if (room) {
                    console.log(`Queue updated for ${roomId}, length: ${room.queue.length}`);
                    io.to(roomId).emit('update_queue', room.queue);

                    // If no song is playing, start this one
                    if (!room.currentSong) {
                        console.log(`No song playing in ${roomId}, auto-starting added song`);
                        const nextSong = room.queue.shift();
                        const updatedRoom = await Room.findOneAndUpdate(
                            { roomId },
                            {
                                currentSong: nextSong,
                                queue: room.queue,
                                isPlaying: true,
                                currentTime: 0
                            },
                            { new: true }
                        );
                        io.to(roomId).emit('receive_play_song', updatedRoom.currentSong);
                        io.to(roomId).emit('update_queue', updatedRoom.queue);
                    }
                } else {
                    console.warn(`Room ${roomId} not found during add_to_queue`);
                }
            } catch (err) {
                console.error('Error adding to queue:', err);
            }
        });

        socket.on('delete_room', async ({ roomId, userId, guestId }) => {
            try {
                const room = await Room.findOne({ roomId });
                if (!room) return;

                const effectiveUserId = userId || guestId;

                // Only creator can delete
                if (!hasDJPermission(room, effectiveUserId) || String(room.creatorId) !== String(effectiveUserId)) {
                    return socket.emit('error', { message: 'Only the room creator can delete this room.' });
                }

                await Room.deleteOne({ roomId });
                console.log(`[DB] Room deleted: ${roomId}`);

                // Inform everyone in the room
                io.to(roomId).emit('room_deleted');

                // Notify all clients to update their active rooms list
                broadcastRooms(io);
            } catch (err) {
                console.error('Error deleting room:', err);
            }
        });

        socket.on('next_song', async ({ roomId, userId, guestId }) => {
            try {
                const room = await Room.findOne({ roomId });
                if (room) {
                    const effectiveUserId = userId || guestId;

                    // Only DJ can skip
                    if (!hasDJPermission(room, effectiveUserId)) {
                        return socket.emit('error', { message: 'Only DJs can skip songs.' });
                    }

                    if (room.queue.length > 0) {
                        const nextSong = room.queue.shift();
                        const updatedRoom = await Room.findOneAndUpdate(
                            { roomId },
                            {
                                currentSong: nextSong,
                                queue: room.queue,
                                isPlaying: true,
                                currentTime: 0
                            },
                            { new: true }
                        );
                        io.to(roomId).emit('receive_play_song', updatedRoom.currentSong);
                        io.to(roomId).emit('update_queue', updatedRoom.queue);
                    } else {
                        await Room.findOneAndUpdate(
                            { roomId },
                            { currentSong: null, isPlaying: false }
                        );
                        io.to(roomId).emit('receive_pause');
                    }
                }
            } catch (err) {
                console.error('Error in next_song:', err);
            }
        });

        socket.on('remove_from_queue', async ({ roomId, queueId, userId, guestId }) => {
            try {
                const roomConfig = await Room.findOne({ roomId });
                const effectiveUserId = userId || guestId;

                // Authorization check
                if (!hasDJPermission(roomConfig, effectiveUserId)) {
                    return console.log("Unauthorized removal attempt");
                }

                const room = await Room.findOneAndUpdate(
                    { roomId },
                    { $pull: { queue: { id: queueId } } },
                    { new: true }
                );

                if (room) {
                    io.to(roomId).emit('update_queue', room.queue);
                    console.log(`Item ${queueId} removed from ${roomId}`);
                }
            } catch (err) {
                console.error('Error removing from queue:', err);
            }
        });

        socket.on('shuffle_queue', async ({ roomId, userId, guestId }) => {
            try {
                const roomConfig = await Room.findOne({ roomId });
                const effectiveUserId = userId || guestId;

                if (!hasDJPermission(roomConfig, effectiveUserId)) {
                    return console.log("Unauthorized shuffle attempt");
                }

                if (!roomConfig || roomConfig.queue.length <= 1) return;

                // Fisher-Yates shuffle
                const shuffled = [...roomConfig.queue];
                for (let i = shuffled.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }

                const room = await Room.findOneAndUpdate(
                    { roomId },
                    { queue: shuffled },
                    { new: true }
                );

                if (room) {
                    io.to(roomId).emit('update_queue', room.queue);
                    console.log(`Queue shuffled for room ${roomId}`);
                }
            } catch (err) {
                console.error('Error shuffling queue:', err);
            }
        });

        socket.on('send_reaction', ({ roomId, emoji }) => {
            io.to(roomId).emit('receive_reaction', { emoji, id: Date.now() });
        });

        // Relay play event
        socket.on('send_play', async ({ roomId, time, userId, guestId }) => {
            try {
                const room = await Room.findOne({ roomId });
                if (room) {
                    const effectiveUserId = userId || guestId;
                    if (!hasDJPermission(room, effectiveUserId)) {
                        return socket.emit('error', { message: 'Only DJs can play music.' });
                    }

                    await Room.findOneAndUpdate({ roomId }, { isPlaying: true, currentTime: time });
                    io.to(roomId).emit('receive_play', { time });
                }
            } catch (err) {
                console.error('Error in send_play:', err);
            }
        });

        // Relay Pause event
        socket.on('send_pause', async ({ roomId, userId, guestId }) => {
            try {
                const room = await Room.findOne({ roomId });
                if (room) {
                    const effectiveUserId = userId || guestId;
                    if (!hasDJPermission(room, effectiveUserId)) {
                        return socket.emit('error', { message: 'Only DJs can pause music.' });
                    }

                    await Room.findOneAndUpdate({ roomId }, { isPlaying: false });
                    io.to(roomId).emit('receive_pause');
                }
            } catch (err) {
                console.error('Error in send_pause:', err);
            }
        });

        // Relay seek event
        socket.on('send_seek', async ({ roomId, time, userId, guestId }) => {
            try {
                const room = await Room.findOne({ roomId });
                if (room) {
                    const effectiveUserId = userId || guestId;
                    if (!hasDJPermission(room, effectiveUserId)) {
                        return socket.emit('error', { message: 'Only DJs can scrub.' });
                    }

                    await Room.findOneAndUpdate({ roomId }, { currentTime: time });
                    io.to(roomId).emit('receive_seek', { time });
                }
            } catch (err) {
                console.error('Error in send_seek:', err);
            }
        });

        socket.on('send_message', (data) => {
            io.to(data.roomId).emit('receive_message', data);
        });

        // Request a song
        socket.on('request_song', async ({ roomId, song, userId, guestId, userName, userColor }) => {
            try {
                console.log('🎵 Song request received:', { roomId, songTitle: song.title, userId, guestId });
                
                const normalizedRoomId = roomId ? String(roomId).toLowerCase() : roomId;
                let room = await Room.findOne({ roomId: normalizedRoomId });
                if (!room) {
                    // fallback to original casing if not found
                    room = await Room.findOne({ roomId });
                }
                if (!room) {
                    console.log('❌ Room not found:', roomId);
                    return socket.emit('error', { message: 'Room not found' });
                }

                // Check for duplicate requests (pending status only)
                const isDuplicate = room.songRequests?.some(
                    req => req.id === song.id && req.status === 'pending'
                );
                if (isDuplicate) {
                    console.log('⚠️ Duplicate request detected:', song.id);
                    return socket.emit('request_feedback', { 
                        type: 'error', 
                        message: 'This song is already requested' 
                    });
                }

                // Also check if song is in queue
                const inQueue = room.queue?.some(q => q.id === song.id);
                if (inQueue) {
                    console.log('⚠️ Song already in queue:', song.id);
                    return socket.emit('request_feedback', { 
                        type: 'error', 
                        message: 'This song is already in the queue' 
                    });
                }

                const effectiveUserId = userId || guestId;
                const newRequest = {
                    _id: new mongoose.Types.ObjectId(),
                    userId: effectiveUserId,
                    userName: userName || 'Guest',
                    userColor: userColor || '#3b82f6',
                    id: song.id,
                    queueId: song.queueId,
                    title: song.title,
                    thumbnail: song.thumbnail,
                    channel: song.channel,
                    duration: song.duration,
                    status: 'pending',
                    requestedAt: new Date()
                };

                // Try updating using normalized roomId first, then fallback
                let updatedRoom = await Room.findOneAndUpdate(
                    { roomId: normalizedRoomId },
                    { $push: { songRequests: newRequest } },
                    { new: true }
                );
                if (!updatedRoom) {
                    updatedRoom = await Room.findOneAndUpdate(
                        { roomId },
                        { $push: { songRequests: newRequest } },
                        { new: true }
                    );
                }

                if (!updatedRoom) {
                    console.error('Failed to persist song request for room:', roomId);
                    return socket.emit('request_feedback', { type: 'error', message: 'Failed to save request' });
                }

                console.log('✅ Request saved, broadcasting update. Total requests:', updatedRoom.songRequests?.length);

                io.to(roomId).emit('song_requests_updated', {
                    songRequests: updatedRoom.songRequests || []
                });

                socket.emit('request_feedback', { 
                    type: 'success',
                    message: 'Song requested successfully!' 
                });

                console.log(`Song requested in ${roomId}: ${song.title}`);
            } catch (err) {
                console.error('Error requesting song:', err);
                socket.emit('error', { message: 'Failed to request song' });
            }
        });

        // Accept a song request
        socket.on('accept_request', async ({ roomId, requestId, userId, guestId }) => {
            try {
                const normalizedRoomId = roomId ? String(roomId).toLowerCase() : roomId;
                let room = await Room.findOne({ roomId: normalizedRoomId });
                if (!room) room = await Room.findOne({ roomId });
                if (!room) return socket.emit('error', { message: 'Room not found' });

                const effectiveUserId = userId || guestId;

                // Only DJs can accept requests
                if (!hasDJPermission(room, effectiveUserId)) {
                    return socket.emit('error', { message: 'Only DJs can accept requests.' });
                }

                // Find the request
                const request = room.songRequests?.find(req => String(req._id) === String(requestId));
                if (!request) {
                    return socket.emit('error', { message: 'Request not found' });
                }

                // Update request status
                // Try updating using normalizedRoomId first, then fallback
                let updatedRoom = await Room.findOneAndUpdate(
                    { roomId: normalizedRoomId, 'songRequests._id': requestId },
                    { 
                        $set: { 'songRequests.$.status': 'accepted' },
                        $push: { 
                            queue: {
                                id: request.id,
                                queueId: request.queueId,
                                title: request.title,
                                thumbnail: request.thumbnail,
                                channel: request.channel,
                                duration: request.duration
                            }
                        }
                    },
                    { new: true }
                );
                if (!updatedRoom) {
                    updatedRoom = await Room.findOneAndUpdate(
                        { roomId, 'songRequests._id': requestId },
                        { 
                            $set: { 'songRequests.$.status': 'accepted' },
                            $push: { 
                                queue: {
                                    id: request.id,
                                    queueId: request.queueId,
                                    title: request.title,
                                    thumbnail: request.thumbnail,
                                    channel: request.channel,
                                    duration: request.duration
                                }
                            }
                        },
                        { new: true }
                    );
                }

                if (!updatedRoom) return socket.emit('error', { message: 'Failed to accept request' });

                io.to(roomId).emit('song_requests_updated', {
                    songRequests: updatedRoom.songRequests || []
                });
                io.to(roomId).emit('update_queue', updatedRoom.queue);

                console.log(`Request accepted in ${roomId}: ${request.title}`);
            } catch (err) {
                console.error('Error accepting request:', err);
                socket.emit('error', { message: 'Failed to accept request' });
            }
        });

        // Decline a song request
        socket.on('decline_request', async ({ roomId, requestId, userId, guestId }) => {
            try {
                const normalizedRoomId = roomId ? String(roomId).toLowerCase() : roomId;
                let room = await Room.findOne({ roomId: normalizedRoomId });
                if (!room) room = await Room.findOne({ roomId });
                if (!room) return socket.emit('error', { message: 'Room not found' });

                const effectiveUserId = userId || guestId;

                // Only DJs can decline requests
                if (!hasDJPermission(room, effectiveUserId)) {
                    return socket.emit('error', { message: 'Only DJs can decline requests.' });
                }

                // Update request status
                let updatedRoom = await Room.findOneAndUpdate(
                    { roomId: normalizedRoomId, 'songRequests._id': requestId },
                    { $set: { 'songRequests.$.status': 'declined' } },
                    { new: true }
                );
                if (!updatedRoom) {
                    updatedRoom = await Room.findOneAndUpdate(
                        { roomId, 'songRequests._id': requestId },
                        { $set: { 'songRequests.$.status': 'declined' } },
                        { new: true }
                    );
                }

                if (!updatedRoom) return socket.emit('error', { message: 'Failed to decline request' });

                io.to(roomId).emit('song_requests_updated', {
                    songRequests: updatedRoom.songRequests || []
                });

                console.log(`Request declined in ${roomId}: ${requestId}`);
            } catch (err) {
                console.error('Error declining request:', err);
                socket.emit('error', { message: 'Failed to decline request' });
            }
        });

        // Grant DJ Permissions
        socket.on('grant_dj_permission', async ({ roomId, targetUserId, userId, guestId }) => {
            try {
                const room = await Room.findOne({ roomId });
                if (!room) return socket.emit('error', { message: 'Room not found' });

                const effectiveUserId = userId || guestId;

                // Only room creator can grant permissions
                if (String(room.creatorId) !== String(effectiveUserId)) {
                    return socket.emit('error', { message: 'Only the room owner can grant DJ permissions.' });
                }

                // Check if already a DJ
                if (room.djPermissions && room.djPermissions.includes(targetUserId)) {
                    return socket.emit('error', { message: 'This user already has DJ permissions.' });
                }

                // Grant DJ permission
                const updatedRoom = await Room.findOneAndUpdate(
                    { roomId },
                    { $push: { djPermissions: targetUserId } },
                    { new: true }
                );

                // Broadcast updated room state
                io.to(roomId).emit('dj_permissions_updated', {
                    djPermissions: updatedRoom.djPermissions || [],
                    message: `DJ permissions granted to user`
                });

                console.log(`DJ permission granted to ${targetUserId} in room ${roomId}`);
                socket.emit('success', { message: 'DJ permission granted' });
            } catch (err) {
                console.error('Error granting DJ permission:', err);
                socket.emit('error', { message: 'Failed to grant DJ permission' });
            }
        });

        // Revoke DJ Permissions
        socket.on('revoke_dj_permission', async ({ roomId, targetUserId, userId, guestId }) => {
            try {
                const room = await Room.findOne({ roomId });
                if (!room) return socket.emit('error', { message: 'Room not found' });

                const effectiveUserId = userId || guestId;

                // Only room creator can revoke permissions
                if (String(room.creatorId) !== String(effectiveUserId)) {
                    return socket.emit('error', { message: 'Only the room owner can revoke DJ permissions.' });
                }

                // Revoke DJ permission
                const updatedRoom = await Room.findOneAndUpdate(
                    { roomId },
                    { $pull: { djPermissions: targetUserId } },
                    { new: true }
                );

                // Broadcast updated room state
                io.to(roomId).emit('dj_permissions_updated', {
                    djPermissions: updatedRoom.djPermissions || [],
                    message: `DJ permissions revoked from user`
                });

                console.log(`DJ permission revoked from ${targetUserId} in room ${roomId}`);
                socket.emit('success', { message: 'DJ permission revoked' });
            } catch (err) {
                console.error('Error revoking DJ permission:', err);
                socket.emit('error', { message: 'Failed to revoke DJ permission' });
            }
        });

        socket.on('disconnect', () => {
            Object.keys(rooms).forEach(roomId => {
                if (rooms[roomId].users[socket.id]) {
                    delete rooms[roomId].users[socket.id];

                    // Notify remaining users
                    io.to(roomId).emit('update_listeners', Object.values(rooms[roomId].users));

                    // If room is now empty, update DB to paused state
                    if (Object.keys(rooms[roomId].users).length === 0) {
                        Room.findOneAndUpdate({ roomId }, { isPlaying: false }).catch(e => console.error(e));
                    }
                }
            });
            broadcastRooms(io);
        });
    });
};

module.exports = { initializeSocket };
