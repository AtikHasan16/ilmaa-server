import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB, collections } from './config/db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// Middleware
app.use(cors({
  origin: CLIENT_ORIGIN,
  credentials: true
}));
app.use(express.json());

// Health check endpoint
app.get('/api/v1/health', async (req, res) => {
  try {
    const userCount = await collections.users().countDocuments();
    res.json({
      success: true,
      status: 'healthy',
      database: 'connected (raw MongoDB)',
      userCount
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      status: 'database unavailable',
      error: err.message
    });
  }
});

// Centralized error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

async function startServer() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`[Server] Imlaa API running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('[Server] Failed to connect to MongoDB. Server not started.', error.message);
  }
}

startServer();
