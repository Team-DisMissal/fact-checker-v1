/* global process */
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), 'server', '.env') });

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_KEY) {
  console.warn('Warning: GEMINI_API_KEY is not set. Set it in server/.env or the process environment. The proxy will return 500 for API calls.');
}

app.post('/api/generate', async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: 'Server API key not configured.' });

  try {
    const upstreamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_KEY}`;
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });

    const data = await upstreamRes.json();
    res.status(upstreamRes.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: 'Proxy failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server proxy listening on http://localhost:${PORT}`);
});
