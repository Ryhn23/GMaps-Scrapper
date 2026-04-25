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

  const { lat, lng, radius = 1000, keyword, type = 'quick', options = {}, limit: reqLimit } = req.body;
  
  // 2. INPUT VALIDATION (Pencegahan request cacat)
  if (!lat || !lng || !keyword) {
    return res.status(400).json({ error: 'Missing required parameters: lat, lng, keyword' });
  }

  // 3. HARD CAP LIMIT (Pencegahan DDoS lewat parameter)
  const limitVal = Math.min(parseInt(reqLimit) || 20, 50); 
  
  // 4. KONVERSI RADIUS KE ZOOM LEVEL GOOGLE MAPS
  // Semakin kecil radius, semakin besar zoom level (mendekat)
  let zoomLevel = 15;
  if (radius <= 500) zoomLevel = 17;
  else if (radius <= 1000) zoomLevel = 16;
  else if (radius <= 3000) zoomLevel = 14;
  else if (radius > 3000) zoomLevel = 13;
  
  isScraping = true;
  currentProgress = { current: 0, total: 0, status: 'initializing' };
  
  console.log(`\n[JOB] Starting: ${keyword} | Mode: ${type} | Limit: ${limitVal} | Radius: ${radius}m (Zoom: ${zoomLevel}z)`);
  
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
    const url = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${lat},${lng},${zoomLevel}z`;
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
      let detailPage = null;
      try {
        const elements = await page.$$('div[role="article"]');
        if (!elements[i]) continue;

        // Ambil URL langsung dari elemen (Lebih stabil daripada klik UI)
        const aHandle = await elements[i].$('a');
        const href = aHandle ? await page.evaluate(a => a.href, aHandle) : null;

        if (!href) {
           console.log(`[-] Warning: Item ${i + 1} skipped (No link found)`);
           currentProgress.current = i + 1;
           continue;
        }

        // BUKA DI TAB BARU: 100% Akurat, tidak terganggu animasi/overlay SPA
        detailPage = await browser.newPage();
        
        // SUPER OPTIMIZATION: Blokir resource visual agar loading 10x lebih cepat & anti-timeout!
        await detailPage.setRequestInterception(true);
        detailPage.on('request', (req) => {
           if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
              req.abort();
           } else {
              req.continue();
           }
        });

        await detailPage.setViewport({ width: 1366, height: 768 });
        await detailPage.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        
        // Memuat halaman dengan sangat cepat karena CSS/Gambar diblokir
        try {
           await detailPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 12000 });
        } catch(e) {
           // Jika loading masih tersendat, abaikan errornya dan biarkan bot mengekstrak DOM yang sudah ada!
        }
        
        try { 
           await detailPage.waitForSelector('h1', { timeout: 5000 }); 
           await delay(1800); // Waktu bernapas ekstra agar XHR data tereksekusi
        } catch(e) {}

        // 1. EKSTRAKSI OVERVIEW DULU (Rating, Address, Phone, Website)
        // Harus dilakukan sebelum pindah ke tab lain!
        let overviewData = await detailPage.evaluate((isDeep, opts) => {
           // Helper cerdas: Ambil dari aria-label agar terhindar dari Ikon Font
           const getAria = (sel, regex) => {
              const el = document.querySelector(sel);
              if (el && el.getAttribute('aria-label')) {
                 return el.getAttribute('aria-label').replace(regex, '').trim();
              }
              if (el) return el.innerText.replace(/[\uE000-\uF8FF]/g, '').trim(); 
              return null;
           };

           let placeName = document.querySelector('h1')?.innerText || document.title.replace(' - Google Maps', '').trim();
           
           let rating = "0.0";
           const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
           if (ratingEl) rating = ratingEl.innerText.replace(',', '.').trim();
           
           let address = getAria('button[data-item-id*="address"]', /^(Address|Alamat):\s*/i);
           
           let result = {
              name: placeName,
              rating: rating,
              address: address || "N/A",
              type: isDeep ? 'DEEP' : 'QUICK'
           };
           
           if (isDeep) {
              const catBtn = document.querySelector('button[jsaction="pane.rating.category"]') || document.querySelector('button.DkEaL');
              if (opts.category) result.category = catBtn ? catBtn.innerText.trim() : "N/A";
              
              if (opts.phone) result.phone = getAria('button[data-item-id*="phone"]', /^(Phone|Telepon):\s*/i) || "N/A";
              if (opts.website) result.website = getAria('button[data-item-id*="authority"]', /^(Website|Situs Web):\s*/i) || "N/A";
           }
           return result;
        }, type === 'deep', options);

        // 2. EKSTRAKSI KHUSUS ABOUT (TENTANG)
        // Dilakukan TERAKHIR karena akan mengubah tampilan layar (Overview akan tertutup)
        let aboutData = "N/A";
        if (type === 'deep' && options.about) {
           try {
              const clicked = await detailPage.evaluate(() => {
                 const tabs = Array.from(document.querySelectorAll('button[role="tab"], div[role="tab"]'));
                 // PENTING: Gunakan toLowerCase() agar kebal terhadap teks kapital 'ABOUT' atau 'TENTANG'
                 const aboutTab = tabs.find(t => {
                    const txt = t.innerText.toLowerCase();
                    return txt === 'about' || txt === 'tentang' || txt.includes('about') || txt.includes('tentang');
                 });
                 if (aboutTab) {
                    aboutTab.scrollIntoView({ behavior: 'instant', block: 'center' });
                    aboutTab.click();
                    return true;
                 }
                 return false;
              });
              
              if (clicked) {
                 await delay(4500); // Waktu tunggu MAXIMAL agar tab About pasti terambil sempurna
                 
                 aboutData = await detailPage.evaluate(() => {
                    // VERIFIKASI MUTLAK: Pastikan tab yang aktif (aria-selected="true") benar-benar tab About!
                    const activeTab = document.querySelector('button[role="tab"][aria-selected="true"], div[role="tab"][aria-selected="true"]');
                    if (!activeTab) return "N/A";
                    
                    const activeTxt = activeTab.innerText.toLowerCase();
                    const isAbout = activeTxt === 'about' || activeTxt === 'tentang' || activeTxt.includes('about') || activeTxt.includes('tentang');
                    if (!isAbout) return "N/A"; // Klik gagal atau loading nyangkut di Overview. Lebih baik N/A daripada salah data!

                    const mainPanel = document.querySelector('div[role="main"]') || document.body;
                    const uls = Array.from(mainPanel.querySelectorAll('ul'));
                    
                    // Fungsi Filter Universal
                    const isOpeningHours = (str) => {
                       const lower = str.toLowerCase();
                       return /senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(lower) || 
                              /\d{1,2}:\d{2}/.test(lower) || 
                              /am\s*-|pm\s*-|-\s*am|-\s*pm|am|pm/i.test(lower);
                    };

                    if (uls.length === 0) {
                       const tabPanel = document.querySelector('div[role="tabpanel"]');
                       if (tabPanel && tabPanel.innerText.length > 10) {
                          const text = tabPanel.innerText.replace(/[\uE000-\uF8FF]/g, '').trim();
                          // Jangan biarkan fallback mengambil opening hours!
                          if (isOpeningHours(text)) return "N/A";
                          return text.replace(/\n+/g, ' | ');
                       }
                       return "N/A";
                    }
                    
                    let result = [];
                    uls.forEach(ul => {
                       let parent = ul.parentElement;
                       let heading = "";
                       for (let i = 0; i < 3; i++) {
                          if (!parent) break;
                          const h = parent.querySelector('h2, [role="heading"], .fontTitleSmall, .fontTitleMedium');
                          if (h && h.innerText) {
                             heading = h.innerText.replace(/[\uE000-\uF8FF]/g, '').trim();
                             break;
                          }
                          parent = parent.parentElement;
                       }
                       
                       const items = Array.from(ul.querySelectorAll('li'))
                          .map(li => li.innerText.replace(/[\uE000-\uF8FF]/g, '').trim())
                          .filter(t => t).join(', ');
                          
                       if (items) {
                          // Terapkan filter pada item
                          if (isOpeningHours(items)) return; 
                          result.push(heading ? `${heading}: ${items}` : items);
                       }
                    });
                    
                    return result.length > 0 ? result.join(' | ') : "N/A";
                 });
              }
           } catch(e) {
              console.log(`[!] Failed to extract About info for item ${i+1}`);
           }
        }

        // 3. GABUNGKAN DATA
        const data = { ...overviewData };
        if (type === 'deep') data.about = aboutData;

        if (data.name) {
          results.push(data);
          console.log(`[+] Captured (${i + 1}/${limit}): ${data.name.substring(0, 30)}`);
        } else {
          console.log(`[-] Warning: Item ${i + 1} skipped (Name not found)`);
        }
      } catch (e) { 
        console.log(`[!] Error item ${i+1}: ${e.message}`);
      } finally {
        if (detailPage) await detailPage.close();
        currentProgress.current = i + 1;
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
