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
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1366,768'
      ]
    });

    const page = await browser.newPage();
    
    // 1. PAKSA VIEWPORT DESKTOP (Sangat Penting untuk VPS Headless)
    await page.setViewport({ width: 1366, height: 768 });
    // Menyamarkan user agent agar terlihat seperti browser asli, bukan bot headless
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    console.log(`[BOT] Loading URL and handling consent...`);
    const url = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${lat},${lng},15z`;
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // 2. BY-PASS GOOGLE CONSENT (Mencegah Layar Tertutup Popup)
    try {
      const consentButtons = await page.$$('button');
      for (let btn of consentButtons) {
        const text = await page.evaluate(el => el.innerText, btn);
        if (text.toLowerCase().includes('accept') || text.toLowerCase().includes('agree') || text.includes('Setuju')) {
          console.log('[BOT] Bypassing Google Consent...');
          await btn.click();
          await delay(2000, 3000);
          break;
        }
      }
    } catch(e) {}

    console.log(`[BOT] Waiting for list elements...`);
    // 3. TUNGGU HASIL
    try {
      await page.waitForSelector('div[role="article"]', { timeout: 15000 });
    } catch (e) {
      console.log(`[!] Peringatan: Tidak ada hasil ditemukan. Kemungkinan diblokir Captcha atau UI Mobile.`);
      // Ambil screenshot sebagai bukti jika terjadi error (Disimpan di server VPS)
      await page.screenshot({ path: 'error_debug.png' });
      return res.json([]);
    }

    console.log(`[BOT] Scrolling to gather max ${limitVal} items...`);
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
    
    console.log(`[BOT] Extraction started for ${limit} items...`);

    for (let i = 0; i < limit; i++) {
      try {
        const elements = await page.$$('div[role="article"]');
        if (!elements[i]) continue;

        await page.evaluate((el) => el.scrollIntoView(), elements[i]);
        
        // Coba klik elemen link di dalamnya jika ada (Lebih aman dari klik div kosong)
        const link = await elements[i].$('a');
        if (link) await link.click();
        else await elements[i].click();
        
        // PENTING: Waktu absolut untuk menunggu panel detail terbuka penuh
        await delay(2500, 3500);

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
          
          let ratingVal = getText('div.F7nice span[aria-hidden="true"]') || getText('span[role="img"]');
          if(!ratingVal || ratingVal.trim() === '') ratingVal = "0.0";

          // Cari nama tempat dengan cerdas (Abaikan h1 pembawa teks sistem)
          let placeName = "";
          const h1s = Array.from(document.querySelectorAll('h1'));
          for (let h of h1s) {
            const txt = h.innerText ? h.innerText.trim() : "";
            if (txt.length > 0 && !txt.toLowerCase().includes('results') && !txt.toLowerCase().includes('hasil')) {
              placeName = txt;
            }
          }

          const result = {
            name: placeName,
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
          console.log(`[+] Captured (${i + 1}/${limit}): ${data.name.substring(0, 30)}`);
        } else {
          console.log(`[-] Warning: Item ${i + 1} skipped (Name not found)`);
        }
        currentProgress.current = i + 1;
      } catch (e) { 
        console.log(`[!] Error item ${i+1}: ${e.message}`);
        continue; 
      }
    }

    currentProgress.status = 'done';
    console.log(`\n[SUCCESS] Total data extracted: ${results.length}`);
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
