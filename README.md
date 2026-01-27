# Music Stream Backend

The backend API for the Music Streaming App, built with Node.js, Express, and Socket.io.

## Features
- User Authentication (JWT)
- Real-time room management with Socket.io
- MongoDB integration with Mongoose
- Synchronized music playback logic

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the root directory:
   ```env
   MONGO_URI=your_mongodb_uri
   JWT_SECRET=your_jwt_secret
   PORT=5000
   ```
3. Run the server:
   ```bash
   npm start
   ```
