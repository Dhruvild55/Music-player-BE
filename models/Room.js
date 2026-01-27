const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    isPublic: {
        type: Boolean,
        default: true
    },
    tags: [
        {
            type: String,
            trim: true
        }
    ],
    description: {
        type: String,
        trim: true,
        maxLength: 100
    },
    owner: {
        type: mongoose.Schema.ObjectId,
        ref: 'User',
        required: false
    },
    creatorId: {
        type: String,
        required: false
    },
    queue: [
        {
            id: String,
            title: String,
            thumbnail: String,
            channel: String,
            duration: Number
        }
    ],
    currentSong: {
        id: String,
        title: String,
        thumbnail: String,
        channel: String,
        duration: Number
    },
    isPlaying: {
        type: Boolean,
        default: false
    },
    currentTime: {
        type: Number,
        default: 0
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 86400 // Automatically delete rooms after 24 hours of inactivity if desired
    }
});

const Room = mongoose.model('Room', roomSchema);
module.exports = Room;
