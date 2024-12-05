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
    origin: ['http://127.0.0.1:5501', 'http://localhost:5501','https://qurandle.com'],
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

app.get('/daily-challenge', async (req, res) => {
    try {
        const { level } = req.query; // Get difficulty level from the request query
        if (!level || !['easy', 'medium', 'hard', 'veryHard'].includes(level)) {
            return res.status(400).json({ message: 'Invalid or missing difficulty level.' });
        }

        // Get current date in Toronto time
        const today = new Date().toLocaleString('en-CA', {
            timeZone: 'America/Toronto',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).split('/').reverse().join('-');  // Ensure YYYY-MM-DD format

        const seed = generateDailySeed(today);
        
        // For 'easy' and 'medium', read local Quran JSON file
        if (level === 'easy' || level === 'medium') {
            try {
                const response = await fetch('http://api.alquran.cloud/v1/surah');
                if (!response.ok) {
                    throw new Error('Failed to fetch Surahs');
                }
                
                const data = await response.json();
                const allSurahs = data.data;

                const surahRanges = {
                    easy: { start: 78, end: 114 },
                    medium: { start: 1, end: 77 }
                };

                const range = surahRanges[level];
                const filteredSurahs = allSurahs.filter(
                    surah => surah.number >= range.start && surah.number <= range.end
                );

                if (!filteredSurahs || filteredSurahs.length === 0) {
                    return res.status(500).json({ message: 'No Surahs available for this difficulty.' });
                }

                const randomSurahIndex = seed % filteredSurahs.length;
                const selectedSurah = filteredSurahs[randomSurahIndex];

                // Fetch verses for the selected Surah
                const versesResponse = await fetch(`http://api.alquran.cloud/v1/surah/${selectedSurah.number}`);
                if (!versesResponse.ok) {
                    throw new Error('Failed to fetch verses');
                }

                const versesData = await versesResponse.json();
                const verses = versesData.data.ayahs;

                // Select 5 consecutive verses
                const totalVerses = verses.length;
                const startIndex = seed % Math.max(totalVerses - 4, 1);
                const selectedVerses = verses.slice(startIndex, startIndex + 5);

                res.set('Cache-Control', 'no-store');
                return res.json({ 
                    surah: {
                        id: selectedSurah.number,
                        name: selectedSurah.name,
                        englishName: selectedSurah.englishName
                    }, 
                    verses: selectedVerses
                });
            } catch (error) {
                console.error('Error in easy/medium challenge:', error);
                return res.status(500).json({ message: 'Failed to fetch Quran data' });
            }
        }

        // For 'hard' and 'veryHard', fetch data from the external API
        else if (level === 'hard') {
            const randomJuz = Math.floor(seed % 30) + 1; // Randomly select a Juz (1-30)
            const response = await fetch(`https://api.alquran.cloud/v1/juz/${randomJuz}/quran-uthmani`);
            if (!response.ok) throw new Error('Failed to fetch Juz data');

            const juzData = await response.json();
            const ayahs = juzData.data.ayahs;

            // Filter ayahs to ensure they belong to the same Surah and exclude first verses
            const surahNumber = ayahs[0].surah.number; // Get the Surah number of the first verse
            const sameSurahAyahs = ayahs.filter(ayah => ayah.surah.number === surahNumber && ayah.numberInSurah !== 1);

            // Randomly select 5 consecutive ayahs
            const startAyahIndex = seed % Math.max(sameSurahAyahs.length - 5, 1);
            const verses = sameSurahAyahs.slice(startAyahIndex, startAyahIndex + 5);

            res.set('Cache-Control', 'no-store'); // Prevent caching
            return res.json({ surah: { id: surahNumber }, verses });
        }

        else if (level === 'veryHard') {
            const randomPage = Math.floor(seed % 604) + 1; // Randomly select a page (1-604)
            const response = await fetch(`https://api.alquran.cloud/v1/page/${randomPage}/quran-uthmani`);
            if (!response.ok) throw new Error('Failed to fetch Quran page');

            const pageData = await response.json();
            const ayahs = pageData.data.ayahs;

            // Filter ayahs to ensure they belong to the same Surah and exclude first verses
            const surahNumber = ayahs[0].surah.number;
            const sameSurahAyahs = ayahs.filter(ayah => ayah.surah.number === surahNumber && ayah.numberInSurah !== 1);

            // Handle cases with fewer than 5 verses
            const startAyahIndex = seed % Math.max(sameSurahAyahs.length - 5, 1);
            const verses = sameSurahAyahs.slice(startAyahIndex, startAyahIndex + 5);

            res.set('Cache-Control', 'no-store'); // Prevent caching
            return res.json({ surah: { id: surahNumber }, verses });
        }
    } catch (error) {
        console.error('Error fetching daily challenge:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

function generateDailySeed(dateString) {
    let hash = 0;
    for (let i = 0; i < dateString.length; i++) {
        hash = (hash * 31 + dateString.charCodeAt(i)) % 233280;
    }
    return hash;
}

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ message: 'Endpoint not found' });
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});