const { v4: uuidv4 } = require('uuid'); // Unique IDs
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');
const os = require('os');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer'); // For handling file uploads
require('dotenv').config(); // Load environment variables

// File Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/'); // Save files in the 'uploads' directory
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`); // Unique filename
  },
});

const upload = multer({ storage });

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json());

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/group_chat';

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('[SUCCESS] Connected to MongoDB'))
  .catch((err) => console.error('[ERROR] MongoDB connection error:', err));

// JWT Secret Key
const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key'; // Use a secure key in .env

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  username: { type: String, required: true, unique: true },
});

const messageSchema = new mongoose.Schema({
  id: { type: String, required: true },
  sender: { type: String, required: true },
  text: { type: String },
  attachment: { type: String },
  time: { type: String, required: true },
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// Authentication Routes
app.post('/api/register', async (req, res) => {
  const { email, password, username } = req.body;

  if (!username || username.trim() === '') {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, username });
    await user.save();
    res.status(201).json({ message: 'User registered successfully' });
  } catch (error) {
    console.error('[ERROR] User registration failed:', error);
    if (error.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern)[0];
      return res.status(400).json({ error: `${duplicateField} already exists` });
    }
    res.status(500).json({ error: 'User registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ email: user.email, username: user.username }, SECRET_KEY, { expiresIn: '1h' });
    res.json({ message: 'Login successful', token, username: user.username });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// File Upload Endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  res.status(200).json({ fileUrl });
});

// Serve Uploaded Files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Socket.IO Logic
io.on('connection', (socket) => {
  console.log(`[INFO] WebSocket connected: ${socket.id}`);

  socket.on('fetchChatHistory', async () => {
    try {
      const messages = await Message.find();
      socket.emit('chatHistory', messages);
    } catch (err) {
      console.error('[ERROR] Fetching chat history failed:', err);
    }
  });

  socket.on('sendMessage', async (data) => {
    try {
      if (!data.sender) {
        console.error('[ERROR] Sender is missing in the message data:', data);
        return;
      }

      const message = new Message({
        id: uuidv4(),
        sender: data.sender,
        text: data.text || null,
        attachment: data.attachment || null,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });

      await message.save();
      io.emit('receiveMessage', message);
    } catch (error) {
      console.error('[ERROR] Failed to save message:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[INFO] WebSocket disconnected: ${socket.id}`);
  });
});

// Utility: Get local network IP
function getLocalIPAddress() {
  const networkInterfaces = os.networkInterfaces();
  for (const interfaceName of Object.keys(networkInterfaces)) {
    for (const iface of networkInterfaces[interfaceName] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// Start Server
const PORT = process.env.PORT || 5000;

function startServer(port) {
  server.listen(port, '0.0.0.0', () => {
    const localIP = getLocalIPAddress();
    console.log(`[SUCCESS] Server running on:`);
    console.log(`- Local: http://localhost:${port}`);
    if (localIP) console.log(`- Network: http://${localIP}:${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[WARNING] Port ${port} is already in use. Trying next port...`);
      startServer(port + 1);
    } else {
      console.error('[ERROR] Failed to start server:', err);
    }
  });
}

startServer(PORT);
