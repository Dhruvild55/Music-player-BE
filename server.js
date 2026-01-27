const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const authRoutes = require('./routes/authRoutes');
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
    process.env.FRONTEND_URL
].filter(Boolean).map(url => url.replace(/\/$/, ""));

app.use(cors({
    origin: (origin, callback) => {
        // Log the origin to help debug live issues
        console.log(`Incoming request from origin: ${origin}`);

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

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
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
            currentSong: r.currentSong
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

    socket.on('create_room', async ({ roomId, isPublic, name, userId }) => {
        try {
            let room = await Room.findOne({ roomId });
            if (!room) {
                room = await Room.create({
                    roomId,
                    name: name || roomId,
                    isPublic: isPublic !== undefined ? isPublic : true,
                    owner: userId // Optional ID if logged in
                });

                if (!rooms[roomId]) {
                    rooms[roomId] = {
                        id: roomId,
                        users: {},
                        skipVotes: new Set()
                    };
                }
                console.log(`Room created in DB: ${roomId}`);
            }
            broadcastRooms();
        } catch (err) {
            console.error('Error creating room:', err);
        }
    });

    socket.on('join_room', async ({ roomId, userProfile }) => {
        socket.join(roomId);

        try {
            // Fetch room from DB
            let roomData = await Room.findOne({ roomId });

            // Fallback for direct joins to non-existent rooms (create temporary one)
            if (!roomData) {
                roomData = await Room.create({
                    roomId,
                    name: roomId,
                    isPublic: true,
                    owner: null
                });
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

            console.log(`User ${rooms[roomId].users[socket.id].name} joined room ${roomId}`);

            // Send existing room state to the new user
            socket.emit('receive_room_state', {
                id: roomData.roomId,
                name: roomData.name,
                queue: roomData.queue,
                currentSong: roomData.currentSong,
                isPlaying: roomData.isPlaying,
                currentTime: roomData.currentTime,
                owner: roomData.owner, // Add this line
                users: Object.values(rooms[roomId].users)
            });

            // Notify others
            io.to(roomId).emit('update_listeners', Object.values(rooms[roomId].users));
            broadcastRooms();
        } catch (err) {
            console.error('Error joining room:', err);
        }
    });

    socket.on('add_to_queue', async ({ roomId, song }) => {
        try {
            const room = await Room.findOneAndUpdate(
                { roomId },
                { $push: { queue: song } },
                { new: true }
            );

            if (room) {
                io.to(roomId).emit('update_queue', room.queue);

                // If no song is playing, start this one
                if (!room.currentSong) {
                    const nextSong = room.queue.shift();
                    const updatedRoom = await Room.findOneAndUpdate(
                        { roomId },
                        {
                            currentSong: nextSong,
                            queue: room.queue,
                            isPlaying: true
                        },
                        { new: true }
                    );
                    io.to(roomId).emit('receive_play_song', updatedRoom.currentSong);
                    io.to(roomId).emit('update_queue', updatedRoom.queue);
                }
            }
        } catch (err) {
            console.error('Error adding to queue:', err);
        }
    });

    socket.on('next_song', async (roomId) => {
        try {
            const room = await Room.findOne({ roomId });
            if (room) {
                rooms[roomId].skipVotes = new Set();

                if (room.queue.length > 0) {
                    const nextSong = room.queue.shift();
                    const updatedRoom = await Room.findOneAndUpdate(
                        { roomId },
                        {
                            currentSong: nextSong,
                            queue: room.queue,
                            isPlaying: true
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
                io.to(roomId).emit('update_skip_votes', {
                    count: 0,
                    threshold: Math.ceil(Object.keys(rooms[roomId].users).length / 2)
                });
            }
        } catch (err) {
            console.error('Error in next_song:', err);
        }
    });

    socket.on('send_reaction', ({ roomId, emoji }) => {
        io.to(roomId).emit('receive_reaction', { emoji, id: Date.now() });
    });

    socket.on('cast_skip_vote', (roomId) => {
        if (rooms[roomId]) {
            if (!rooms[roomId].skipVotes) rooms[roomId].skipVotes = new Set();

            if (rooms[roomId].skipVotes.has(socket.id)) {
                rooms[roomId].skipVotes.delete(socket.id);
            } else {
                rooms[roomId].skipVotes.add(socket.id);
            }

            const voteCount = rooms[roomId].skipVotes.size;
            const userCount = Object.keys(rooms[roomId].users).length;
            const threshold = Math.ceil(userCount / 2);

            io.to(roomId).emit('update_skip_votes', {
                count: voteCount,
                threshold: threshold
            });

            if (voteCount >= threshold) {
                // Trigger auto-skip
                rooms[roomId].skipVotes = new Set();
                if (rooms[roomId].queue.length > 0) {
                    rooms[roomId].currentSong = rooms[roomId].queue.shift();
                    io.to(roomId).emit('receive_play_song', rooms[roomId].currentSong);
                    io.to(roomId).emit('update_queue', rooms[roomId].queue);
                    io.to(roomId).emit('update_skip_votes', { count: 0, threshold });
                } else {
                    rooms[roomId].currentSong = null;
                    rooms[roomId].isPlaying = false;
                    io.to(roomId).emit('receive_pause');
                }
            }
        }
    });

    // Relay play event
    socket.on('send_play', async (data) => {
        try {
            await Room.findOneAndUpdate(
                { roomId: data.roomId },
                { isPlaying: true, currentTime: data.time }
            );
            socket.to(data.roomId).emit('receive_play', { time: data.time });
        } catch (err) {
            console.error('Error in send_play:', err);
        }
    });

    // Relay Pause event
    socket.on('send_pause', async (data) => {
        try {
            await Room.findOneAndUpdate(
                { roomId: data.roomId },
                { isPlaying: false }
            );
            socket.to(data.roomId).emit('receive_pause');
        } catch (err) {
            console.error('Error in send_pause:', err);
        }
    });

    // Relay seek event
    socket.on('send_seek', async (data) => {
        try {
            await Room.findOneAndUpdate(
                { roomId: data.roomId },
                { currentTime: data.time }
            );
            socket.to(data.roomId).emit('receive_seek', { time: data.time });
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
