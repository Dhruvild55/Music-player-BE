const mongoose = require('mongoose');

const playlistSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    owner: {
        type: mongoose.Schema.ObjectId,
        ref: 'User',
        required: true
    },
    songs: [
        {
            id: { type: String, required: true },
            title: { type: String, required: true },
            thumbnail: String,
            channel: String,
            duration: Number
        }
    ],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const Playlist = mongoose.model('Playlist', playlistSchema);
module.exports = Playlist;
