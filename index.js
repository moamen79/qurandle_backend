const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const admin = require('firebase-admin');

// Parse service account from environment variable
const serviceAccountKey = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccountKey),
    databaseURL: "https://qurandle-login-default-rtdb.firebaseio.com"
});


const db = admin.database(); // Reference to Firebase Realtime Database

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: ['http://qurandle.s3-website.us-east-2.amazonaws.com'],
    credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const SECRET_KEY = 'your_jwt_secret_key'; // Use a more secure key in production

app.get('/', (req, res) => {
    res.send('Qurandle backend is running with Firebase');
});

app.use((req, res, next) => {
    console.log(`Received ${req.method} request for ${req.url}`);
    next();
});

// Firebase Helper Functions
const getUserRef = (username) => db.ref(`users/${username}`);
const getLeaderboardRef = (level) => db.ref(`leaderboard/${level}`);

// Sign Up
app.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    const userRef = getUserRef(username);

    const snapshot = await userRef.once('value');
    if (snapshot.exists()) {
        return res.status(400).json({ message: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await userRef.set({ password: hashedPassword });
    res.status(201).json({ message: 'User registered successfully' });
});

// Login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const userRef = getUserRef(username);

    const snapshot = await userRef.once('value');
    if (!snapshot.exists()) {
        return res.status(400).json({ message: 'Invalid credentials' });
    }

    const userData = snapshot.val();
    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
        return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: '1h' });
    res.json({ token, username });
});

// JWT Authentication Middleware
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Submit Score
app.post('/submit-score', authenticateJWT, async (req, res) => {
    const { score, level } = req.body;
    if (!score || !level) {
        return res.status(400).json({ message: 'Score and level must be provided' });
    }

    const leaderboardRef = getLeaderboardRef(level);
    const snapshot = await leaderboardRef.once('value');
    const leaderboard = snapshot.val() || [];

    const userIndex = leaderboard.findIndex(entry => entry.username === req.user.username);

    if (userIndex !== -1) {
        if (score > leaderboard[userIndex].score) {
            leaderboard[userIndex].score = score;
        }
    } else {
        leaderboard.push({ username: req.user.username, score });
    }

    leaderboard.sort((a, b) => b.score - a.score);
    await leaderboardRef.set(leaderboard.slice(0, 10)); // Save top 10 scores
    res.status(201).json({ message: 'Score submitted successfully' });
});

// Get Leaderboard
app.get('/leaderboard', async (req, res) => {
    const { level } = req.query;
    if (!level) {
        return res.status(400).json({ message: 'Level must be provided' });
    }

    const leaderboardRef = getLeaderboardRef(level);
    const snapshot = await leaderboardRef.once('value');
    const leaderboard = snapshot.val() || [];
    res.json(leaderboard);
});

// Remove Score (Admin Only)
app.post('/remove-score', authenticateJWT, async (req, res) => {
    const { username, level } = req.body;
    if (!username || !level) {
        return res.status(400).json({ message: 'Username and level must be provided' });
    }

    const leaderboardRef = getLeaderboardRef(level);
    const snapshot = await leaderboardRef.once('value');
    const leaderboard = snapshot.val() || [];

    const updatedLeaderboard = leaderboard.filter(entry => entry.username !== username);
    await leaderboardRef.set(updatedLeaderboard);

    res.json({ message: 'Score removed successfully' });
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ message: 'Endpoint not found' });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
