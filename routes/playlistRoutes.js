const express = require('express');
const router = express.Router();
const Playlist = require('../models/Playlist');
const { protect } = require('../middleware/authMiddleware');

// All playlist routes are protected
router.use(protect);

// Get all user playlists
router.get('/', async (req, res) => {
    try {
        const playlists = await Playlist.find({ owner: req.user.id }).sort('-createdAt');
        res.status(200).json({
            status: 'success',
            results: playlists.length,
            data: { playlists }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// Create a new playlist
router.post('/', async (req, res) => {
    try {
        const newPlaylist = await Playlist.create({
            name: req.body.name,
            owner: req.user.id,
            songs: req.body.songs || []
        });
        res.status(201).json({
            status: 'success',
            data: { playlist: newPlaylist }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// Update a playlist (add songs or change name)
router.patch('/:id', async (req, res) => {
    try {
        const playlist = await Playlist.findOneAndUpdate(
            { _id: req.params.id, owner: req.user.id },
            req.body,
            { new: true, runValidators: true }
        );

        if (!playlist) {
            return res.status(404).json({ status: 'error', message: 'Playlist not found' });
        }

        res.status(200).json({
            status: 'success',
            data: { playlist }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// Delete a playlist
router.delete('/:id', async (req, res) => {
    try {
        const playlist = await Playlist.findOneAndDelete({ _id: req.params.id, owner: req.user.id });

        if (!playlist) {
            return res.status(404).json({ status: 'error', message: 'Playlist not found' });
        }

        res.status(204).json({
            status: 'success',
            data: null
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
