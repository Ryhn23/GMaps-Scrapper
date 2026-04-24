require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');

puppeteer.use(StealthPlugin());

const app = express();

// Konfigurasi CORS yang lebih aman
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const delay = (min, max) => new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1) + min)));

let currentProgress = { current: 0, total: 0, status: 'idle' };
let isScraping = false; // ENGINE LOCK: Mencegah server overload

app.get('/ping', (req, res) => res.send('ok'));
app.get('/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const interval = setInterval(() => {
    res.write(`data: ${JSON.stringify(currentProgress)}\n\n`);
  }, 500);
  req.on('close', () => clearInterval(interval));
});

app.post('/scrape', async (req, res) => {
  // 1. CONCURRENCY LOCK (Hanya 1 proses scraping di waktu bersamaan)
  if (isScraping) {
    return res.status(429).json({ error: 'Engine is currently busy processing another request. Please wait.' });
  }

  const { lat, lng, keyword, type = 'quick', options = {}, limit: reqLimit } = req.body;
  
  // 2. INPUT VALIDATION (Pencegahan request cacat)
  if (!lat || !lng || !keyword) {
    return res.status(400).json({ error: 'Missing required parameters: lat, lng, keyword' });
  }

  // 3. HARD CAP LIMIT (Pencegahan DDoS lewat parameter)
  const limitVal = Math.min(parseInt(reqLimit) || 20, 50); 
  
  isScraping = true;
  currentProgress = { current: 0, total: 0, status: 'initializing' };
  
  console.log(`\n[JOB] Starting: ${keyword} | Mode: ${type} | Limit: ${limitVal}`);
  
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--window-size=1366,768'
      ]
    });

    const page = await browser.newPage();
    const url = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${lat},${lng},15z`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    try {
      await page.waitForSelector('div[role="article"]', { timeout: 10000 });
    } catch (e) {
      return res.json([]);
    }

    // Scroll Logic
    for (let attempts = 0; attempts < Math.max(6, limitVal / 3); attempts++) {
      const currentItems = await page.$$('div[role="article"]');
      if (currentItems.length >= limitVal) break; 
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollBy(0, 3000);
      });
      await delay(800, 1200);
    }

    const items = await page.$$('div[role="article"]');
    const limit = Math.min(items.length, limitVal);
    const results = [];
    currentProgress = { current: 0, total: limit, status: 'extracting' };

    for (let i = 0; i < limit; i++) {
      try {
        const elements = await page.$$('div[role="article"]');
        if (!elements[i]) continue;

        await page.evaluate((el) => el.scrollIntoView(), elements[i]);
        await elements[i].click();
        try { await page.waitForSelector('h1.DUwDvf', { timeout: 5000 }); } catch(e) {}
        await delay(1500, 2000);

        let aboutData = "";

        if (type === 'deep' && options.about) {
          try {
            const aboutBtn = await page.evaluateHandle(() => {
              const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
              return tabs.find(t => t.innerText.includes('About') || t.innerText.includes('Tentang'));
            });
            if (aboutBtn.asElement()) {
              await aboutBtn.asElement().click();
              await delay(1500, 2000);
              aboutData = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.iP2t7d')).map(sec => {
                  const title = sec.querySelector('.fontTitleSmall')?.innerText || "";
                  const items = Array.from(sec.querySelectorAll('.m6QErb li')).map(li => li.innerText).join(', ');
                  return title ? `${title}: ${items}` : items;
                }).join(' | ');
              });
              const overview = await page.evaluateHandle(() => {
                const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
                return tabs.find(t => t.innerText.includes('Overview') || t.innerText.includes('Ringkasan'));
              });
              if (overview.asElement()) await overview.asElement().click();
              await delay(800, 1200);
            }
          } catch(e) {}
        }

        const data = await page.evaluate((isDeep, opts, about) => {
          const getText = (sel) => document.querySelector(sel)?.innerText || "";
          const infoElements = Array.from(document.querySelectorAll('button[data-item-id]'));
          let ratingVal = getText('div.F7nice span[aria-hidden="true"]');
          if(!ratingVal || ratingVal.trim() === '') ratingVal = "0.0";

          const result = {
            name: getText('h1.DUwDvf'),
            rating: ratingVal,
            address: infoElements.find(el => el.getAttribute('data-item-id')?.includes('address'))?.innerText || "N/A",
            type: isDeep ? 'DEEP' : 'QUICK'
          };
          if (isDeep) {
            if (opts.category) result.category = getText('button[jsaction="pane.rating.category"]');
            if (opts.phone) result.phone = infoElements.find(el => el.getAttribute('data-item-id')?.includes('phone'))?.innerText;
            if (opts.website) result.website = infoElements.find(el => el.getAttribute('data-item-id')?.includes('authority'))?.innerText;
            if (opts.about) result.about = about;
          }
          return result;
        }, type === 'deep', options, aboutData);

        if (data.name) {
          results.push(data);
          console.log(`[+] Captured (${i + 1}/${limit}): ${data.name}`);
        }
        currentProgress.current = i + 1;
      } catch (e) { continue; }
    }

    currentProgress.status = 'done';
    res.json(results);
  } catch (error) {
    console.error('[FATAL ENGINE ERROR]', error);
    res.status(500).json({ error: error.message || 'Internal Server Error' });
  } finally {
    isScraping = false; // RELEASE LOCK
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => console.log(`PROD ENGINE ONLINE ON PORT ${PORT}`));
