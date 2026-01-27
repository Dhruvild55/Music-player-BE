const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/authRoutes');
const playlistRoutes = require('./routes/playlistRoutes');
const Room = require('./models/Room');
const User = require('./models/User');

dotenv.config();

const app = express();
app.set('trust proxy', 1);
const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:4173",
    "https://music-palyer-fe.vercel.app",
    process.env.FRONTEND_URL
].filter(Boolean).map(url => url.replace(/\/$/, ""));

console.log("Allowed Origins:", allowedOrigins);

app.use(cors({
    origin: (origin, callback) => {
        // Log the origin to help debug live issues
        if (origin) console.log(`Incoming request from origin: ${origin}`);

        if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
            callback(null, true);
        } else {
            console.warn(`CORS blocked for origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/playlists', playlistRoutes);

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin.replace(/\/$/, ""))) {
                callback(null, true);
            } else {
                console.warn(`Socket CORS blocked for origin: ${origin}`);
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"],
        credentials: true
    }
});

// In-memory store for live state (listeners, skipVotes)
const rooms = {};

const broadcastRooms = async () => {
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
initRooms();

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send initial list of rooms
    broadcastRooms();

    socket.on('get_active_rooms', () => {
        broadcastRooms();
    });

    socket.on('create_room', async ({ roomId, isPublic, name, userId, guestId, tags, description }) => {
        try {
            let room = await Room.findOne({ roomId });
            if (!room) {
                room = await Room.create({
                    roomId,
                    name: name || roomId,
                    isPublic: isPublic !== undefined ? isPublic : true,
                    owner: userId,
                    creatorId: userId || guestId,
                    tags: tags || [],
                    description: description || ""
                });

                if (!rooms[roomId]) {
                    rooms[roomId] = {
                        id: roomId,
                        users: {},
                        skipVotes: new Set()
                    };
                }
                console.log(`Room created with tags: ${tags}`);
            }
            broadcastRooms();
        } catch (err) {
            console.error('Error creating room:', err);
        }
    });

    socket.on('join_room', async ({ roomId, userProfile, guestId }) => {
        const effectiveUserId = userProfile?.userId || guestId;
        console.log(`User ${userProfile?.name} (ID: ${effectiveUserId}) joining room: ${roomId}`);
        socket.join(roomId);

        try {
            // Fetch room from DB
            let roomData = await Room.findOne({ roomId });

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

            // Store user metadata in memory
            rooms[roomId].users[socket.id] = {
                id: socket.id,
                name: userProfile?.name || `User_${socket.id.substring(0, 4)}`,
                color: userProfile?.color || '#3b82f6'
            };

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
                users: Object.values(rooms[roomId].users)
            };

            console.log(`Sending state to user ${socket.id} for room ${roomId}`);
            socket.emit('receive_room_state', state);

            // Notify others
            io.to(roomId).emit('update_listeners', Object.values(rooms[roomId].users));
            broadcastRooms();
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
            if (room.creatorId && String(room.creatorId) !== String(effectiveUserId)) {
                return socket.emit('error', { message: 'Only the room creator can delete this room.' });
            }

            await Room.deleteOne({ roomId });
            console.log(`[DB] Room deleted: ${roomId}`);

            // Inform everyone in the room
            io.to(roomId).emit('room_deleted');

            // Notify all clients to update their active rooms list
            broadcastRooms();
        } catch (err) {
            console.error('Error deleting room:', err);
        }
    });

    socket.on('next_song', async ({ roomId, userId, guestId }) => {
        try {
            const room = await Room.findOne({ roomId });
            if (room) {
                const effectiveUserId = userId || guestId;

                // Only creator can skip
                if (room.creatorId && String(room.creatorId) !== String(effectiveUserId)) {
                    return socket.emit('error', { message: 'Only the room creator can skip songs.' });
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
            if (roomConfig && String(roomConfig.creatorId) !== String(effectiveUserId)) {
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

            if (roomConfig && String(roomConfig.creatorId) !== String(effectiveUserId)) {
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
                if (room.creatorId && String(room.creatorId) !== String(effectiveUserId)) {
                    return socket.emit('error', { message: 'Only the room creator can play music.' });
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
                if (room.creatorId && String(room.creatorId) !== String(effectiveUserId)) {
                    return socket.emit('error', { message: 'Only the room creator can pause music.' });
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
                if (room.creatorId && String(room.creatorId) !== String(effectiveUserId)) {
                    return socket.emit('error', { message: 'Only the room creator can scrub.' });
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
        broadcastRooms();
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
