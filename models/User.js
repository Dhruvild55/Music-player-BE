const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: [true, 'Please provide a username'],
        unique: true,
        trim: true
    },
    email: {
        type: String,
        required: [true, 'Please provide an email'],
        unique: true,
        lowercase: true,
        match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
    },
    password: {
        type: String,
        required: [true, 'Please provide a password'],
        minlength: 6,
        select: false
    },
    avatarColor: {
        type: String,
        default: '#3b82f6'
    },
    bio: {
        type: String,
        maxlength: 200,
        default: ''
    },
    following: [{
        type: mongoose.Schema.ObjectId,
        ref: 'User'
    }],
    followers: [{
        type: mongoose.Schema.ObjectId,
        ref: 'User'
    }],
    listeningHistory: [{
        roomId: String,
        roomName: String,
        timestamp: {
            type: Date,
            default: Date.now
        },
        duration: Number // in seconds
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Virtual for created rooms count
userSchema.virtual('createdRooms', {
    ref: 'Room',
    localField: '_id',
    foreignField: 'owner'
});

// Hash password before saving
userSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, 12);
});

// Method to check password
userSchema.methods.correctPassword = async function (candidatePassword, userPassword) {
    return await bcrypt.compare(candidatePassword, userPassword);
};

const User = mongoose.model('User', userSchema);
module.exports = User;
