import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'database.json');
const USER_DB_PATH = path.join(__dirname, 'user_data.json');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

// Helper to read built-in database
async function readDatabase() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database, returning empty list:', error);
    return [];
  }
}

// Helper to read user_data.json
async function readUserData() {
  try {
    const data = await fs.readFile(USER_DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading user database, returning default skeleton:', error);
    return { users: {}, progress: {}, customWords: {} };
  }
}

// Helper to write to user_data.json
async function writeUserData(data) {
  try {
    await fs.writeFile(USER_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('Error writing to user database:', error);
    return false;
  }
}

// Session store in memory: sessionToken -> userEmail
const activeSessions = new Map();

// Helper to parse cookie from headers
function getSessionCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
    const [name, value] = cookie.trim().split('=');
    if (name && value) acc[name] = decodeURIComponent(value);
    return acc;
  }, {});
  return cookies['session'];
}

// Helper to retrieve logged-in user email
function getLoggedInUserEmail(req) {
  const token = getSessionCookie(req);
  if (!token) return null;
  return activeSessions.get(token) || null;
}

// Helper to decode Google JWT payload without external libraries
function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    console.error('Error decoding JWT:', e);
    return null;
  }
}

// POST endpoint for Google Login
app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ error: 'Missing credential token' });
  }

  const payload = decodeJwt(credential);
  if (!payload || !payload.email) {
    return res.status(400).json({ error: 'Invalid token format' });
  }

  const email = payload.email.toLowerCase().trim();
  const name = payload.name;
  const picture = payload.picture;

  // Persist user record in user_data.json
  const userData = await readUserData();
  userData.users[email] = { name, picture };
  await writeUserData(userData);

  // Generate a random session token
  const sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
  activeSessions.set(sessionToken, email);

  // Set HttpOnly, secure (optional in dev, let lax same-site) cookie valid for 7 days
  res.setHeader('Set-Cookie', `session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`);

  res.json({
    success: true,
    user: { name, email, picture }
  });
});

// GET endpoint to fetch current user session
app.get('/api/auth/me', async (req, res) => {
  const email = getLoggedInUserEmail(req);
  if (!email) {
    return res.json({ user: null });
  }

  const userData = await readUserData();
  const userRecord = userData.users[email];
  if (!userRecord) {
    return res.json({ user: null });
  }

  res.json({
    user: {
      name: userRecord.name,
      email: email,
      picture: userRecord.picture
    }
  });
});

// POST endpoint to logout
app.post('/api/auth/logout', (req, res) => {
  const token = getSessionCookie(req);
  if (token) {
    activeSessions.delete(token);
  }
  // Clear the cookie on client
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ success: true });
});

// GET all vocabulary (merges built-in list with user-specific states and custom words)
app.get('/api/vocabulary', async (req, res) => {
  const masterList = await readDatabase();
  const email = getLoggedInUserEmail(req);

  if (!email) {
    // If not logged in, return master list with default unmemorized and unstarred states
    const defaultList = masterList.map(w => ({
      ...w,
      isMemorized: false,
      isStarred: false
    }));
    return res.json(defaultList);
  }

  const userData = await readUserData();
  const userProgress = userData.progress[email] || {};
  const userCustomWords = userData.customWords[email] || [];

  // Merge study states for built-in words
  const mergedList = masterList.map(item => {
    const state = userProgress[item.id.toString()];
    return {
      ...item,
      isMemorized: state ? !!state.isMemorized : false,
      isStarred: state ? !!state.isStarred : false
    };
  });

  // Append user-specific custom words
  const mappedCustomWords = userCustomWords.map(cw => ({
    ...cw,
    isCustom: true
  }));

  res.json([...mergedList, ...mappedCustomWords]);
});

// POST toggle memorized
app.post('/api/vocabulary/toggle-memorized', async (req, res) => {
  const email = getLoggedInUserEmail(req);
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing word ID' });
  }

  const wordId = parseInt(id);
  const userData = await readUserData();

  if (wordId >= 100000) {
    // Custom word progress toggle
    const userCustomWords = userData.customWords[email] || [];
    const wordIndex = userCustomWords.findIndex(w => w.id === wordId);
    if (wordIndex === -1) {
      return res.status(404).json({ error: 'Custom word not found' });
    }

    userCustomWords[wordIndex].isMemorized = !userCustomWords[wordIndex].isMemorized;
    await writeUserData(userData);
    return res.json(userCustomWords[wordIndex]);
  } else {
    // Built-in word progress toggle
    const masterList = await readDatabase();
    const wordIndex = masterList.findIndex(w => w.id === wordId);
    if (wordIndex === -1) {
      return res.status(404).json({ error: 'Word not found' });
    }

    if (!userData.progress[email]) {
      userData.progress[email] = {};
    }

    const wordKey = wordId.toString();
    const currentProgress = userData.progress[email][wordKey] || { isMemorized: false, isStarred: false };

    userData.progress[email][wordKey] = {
      ...currentProgress,
      isMemorized: !currentProgress.isMemorized
    };

    await writeUserData(userData);

    res.json({
      ...masterList[wordIndex],
      isMemorized: userData.progress[email][wordKey].isMemorized,
      isStarred: userData.progress[email][wordKey].isStarred
    });
  }
});

// POST toggle starred
app.post('/api/vocabulary/toggle-starred', async (req, res) => {
  const email = getLoggedInUserEmail(req);
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Missing word ID' });
  }

  const wordId = parseInt(id);
  const userData = await readUserData();

  if (wordId >= 100000) {
    // Custom word starred toggle
    const userCustomWords = userData.customWords[email] || [];
    const wordIndex = userCustomWords.findIndex(w => w.id === wordId);
    if (wordIndex === -1) {
      return res.status(404).json({ error: 'Custom word not found' });
    }

    userCustomWords[wordIndex].isStarred = !userCustomWords[wordIndex].isStarred;
    await writeUserData(userData);
    return res.json(userCustomWords[wordIndex]);
  } else {
    // Built-in word starred toggle
    const masterList = await readDatabase();
    const wordIndex = masterList.findIndex(w => w.id === wordId);
    if (wordIndex === -1) {
      return res.status(404).json({ error: 'Word not found' });
    }

    if (!userData.progress[email]) {
      userData.progress[email] = {};
    }

    const wordKey = wordId.toString();
    const currentProgress = userData.progress[email][wordKey] || { isMemorized: false, isStarred: false };

    userData.progress[email][wordKey] = {
      ...currentProgress,
      isStarred: !currentProgress.isStarred
    };

    await writeUserData(userData);

    res.json({
      ...masterList[wordIndex],
      isMemorized: userData.progress[email][wordKey].isMemorized,
      isStarred: userData.progress[email][wordKey].isStarred
    });
  }
});

// POST add a custom word for the logged-in user
app.post('/api/vocabulary', async (req, res) => {
  const email = getLoggedInUserEmail(req);
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }

  const { word, pinyin, meaning, level, category, example_zh, example_vi } = req.body;

  if (!word || !pinyin || !meaning) {
    return res.status(400).json({ error: 'Word, pinyin, and meaning are required fields' });
  }

  const userData = await readUserData();
  if (!userData.customWords[email]) {
    userData.customWords[email] = [];
  }

  // Calculate next custom ID (custom words start at 100000 to avoid conflicts with HSK words)
  const maxId = userData.customWords[email].reduce((max, w) => w.id > max ? w.id : max, 99999);

  const newWord = {
    id: maxId + 1,
    word: word.trim(),
    pinyin: pinyin.trim(),
    meaning: meaning.trim().toLowerCase(),
    level: parseInt(level) || 1,
    category: category ? category.trim() : 'Khác',
    example_zh: example_zh ? example_zh.trim() : '',
    example_vi: example_vi ? example_vi.trim().toLowerCase() : '',
    isMemorized: false,
    isStarred: false,
    isCustom: true
  };

  userData.customWords[email].push(newWord);
  await writeUserData(userData);

  res.status(201).json(newWord);
});

// DELETE a custom word belonging to the logged-in user
app.delete('/api/vocabulary/:id', async (req, res) => {
  const email = getLoggedInUserEmail(req);
  if (!email) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }

  const { id } = req.params;
  const wordId = parseInt(id);

  if (isNaN(wordId)) {
    return res.status(400).json({ error: 'Invalid word ID' });
  }

  if (wordId < 100000) {
    return res.status(403).json({ error: 'Cannot delete built-in HSK words' });
  }

  const userData = await readUserData();
  const userCustomWords = userData.customWords[email] || [];
  const wordIndex = userCustomWords.findIndex(w => w.id === wordId);

  if (wordIndex === -1) {
    return res.status(404).json({ error: 'Custom word not found' });
  }

  // Remove custom word
  userData.customWords[email] = userCustomWords.filter(w => w.id !== wordId);
  await writeUserData(userData);

  res.json({ message: 'Word deleted successfully', id: wordId });
});

// GET endpoint to proxy TTS audio and stream it
app.get('/api/tts', (req, res) => {
  const { text } = req.query;
  if (!text) {
    return res.status(400).json({ error: 'Missing text parameter' });
  }

  const query = encodeURIComponent(text);
  const urls = [
    `https://dict.youdao.com/dictvoice?audio=${query}&type=2`,
    `https://tts.baidu.com/text2audio?lan=zh&ie=UTF-8&spd=5&text=${query}`,
    `https://translate.google.com/translate_tts?ie=UTF-8&tl=zh-CN&client=tw-ob&q=${query}`
  ];

  function tryUrl(index) {
    if (index >= urls.length) {
      return res.status(500).json({ error: 'All TTS engines failed' });
    }

    const ttsUrl = urls[index];
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    https.get(ttsUrl, { headers }, (response) => {
      // Follow redirect if 301 or 302
      if (response.statusCode === 302 || response.statusCode === 301) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          https.get(redirectUrl, { headers }, (redirectRes) => {
            if (redirectRes.statusCode === 200) {
              res.setHeader('Content-Type', 'audio/mpeg');
              redirectRes.pipe(res);
            } else {
              tryUrl(index + 1);
            }
          }).on('error', () => tryUrl(index + 1));
          return;
        }
      }

      if (response.statusCode === 200) {
        res.setHeader('Content-Type', 'audio/mpeg');
        response.pipe(res);
      } else {
        console.warn(`TTS source ${index} returned status ${response.statusCode}`);
        tryUrl(index + 1);
      }
    }).on('error', (err) => {
      console.warn(`TTS source ${index} error:`, err);
      tryUrl(index + 1);
    });
  }

  tryUrl(0);
});

// Thêm đoạn này để xử lý đường dẫn gốc
app.get('/', (req, res) => {
  res.send('API Flashcard HSK đang hoạt động ngon lành!');
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});