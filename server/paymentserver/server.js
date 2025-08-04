const fs = require('fs');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QRCode = require('qrcode');
const { CookieJar, Cookie } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
require('dotenv').config();
const path = require('path');

const {
  UPI_ADDRESS,
  UPI_NAME,
  PORT = 3001,
  COMMENT_FETCH_PER_SECONDS = 5,
  CLIENT_SERVER_URL
} = process.env;

const URL = 'https://www.freecharge.in/thv/listv3?fcAppType=MSITE';
const COOKIES_FILE = 'cookies.txt';

function loadCookiesFromFile(jar, filename) {
  if (!fs.existsSync(filename)) return;
  const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const [domain,, pathPart, secureFlag, expStr, name, value] = line.split('\t');
    const cookie = new Cookie({
      key: name,
      value,
      domain: domain.replace(/^\./, ''),
      path: pathPart,
      secure: secureFlag === 'TRUE',
      httpOnly: false,
      expires: expStr === '0' ? 'Infinity' : new Date(Number(expStr) * 1000)
    });
    const url = `${cookie.secure ? 'https' : 'http'}://${domain}${pathPart}`;
    jar.setCookieSync(cookie, url);
  }
}

async function fetchTransactions() {
  const jar = new CookieJar();
  loadCookiesFromFile(jar, COOKIES_FILE);
  const client = wrapper(axios.create({ jar, withCredentials: true }));
  const payload = {
    userImsId: '',
    isAndroid: false,
    fromDate: null,
    toDate: null,
    paymentStatus: '',
    paymentDirection: '',
    paymentAccountType: ''
  };
  const resp = await client.post(URL, payload, {
    headers: {
      Host: 'www.freecharge.in',
      Connection: 'keep-alive',
      'sec-ch-ua-platform': '"Windows"',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      csrfRequestIdentifier: '',
      'Content-Type': 'application/json',
      'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      Origin: 'https://www.freecharge.in',
      Referer: 'https://www.freecharge.in/',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  return resp.data?.data?.globalTransactions || [];
}

async function findTransactionByComment(comment) {
  const txns = await fetchTransactions();
  for (const txn of txns) {
    const meta = {};
    for (const section of txn.billerInfo?.billerMetaData || []) {
      for (const d of section.sectionDetails || []) {
        if (d.name) meta[d.name] = d.value || '';
      }
    }
    if (Object.values(meta).includes(comment)) {
      return { meta, txnDetails: txn.txnDetails || {} };
    }
    if (JSON.stringify(txn).includes(comment)) {
      return { meta, txnDetails: txn.txnDetails || {} };
    }
  }
  return null;
}

async function checkFreechargeCookies() {
  const jar2 = new CookieJar();
  loadCookiesFromFile(jar2, COOKIES_FILE);
  const client2 = wrapper(axios.create({
    jar: jar2,
    withCredentials: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
    }
  }));
  const historyUrl = 'https://www.freecharge.in/transactions-history';
  try {
    const res = await client2.get(historyUrl, { maxRedirects: 0, validateStatus: s => s < 400 });
    if ((res.status === 301 || res.status === 302) && (res.headers.location||'').includes('/services')) {
      return false;
    } else if (res.status === 200) {
      if (/login\s*\/\s*register/i.test(res.data)) return false;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/session/:comment', async (req, res) => {
  try {
    const resp = await axios.get(`${CLIENT_SERVER_URL}/amount/${req.params.comment}`);
    return res.json({ comment: req.params.comment, amount: resp.data.amount });
  } catch (err) {
    console.error('Session lookup error:', err);
    let detail = err.message;
    if (err.response) {
      detail = `${err.response.status} ${err.response.statusText}: ${JSON.stringify(err.response.data)}`;
    }
    return res
      .status(err.response?.status || 500)
      .json({ error: `Session lookup error: ${detail}` });
  }
});

app.get('/generate', async (req, res) => {
  const { comment, amount } = req.query;
  if (!comment || !amount) {
    return res.status(400).json({ error: 'comment & amount required' });
  }
  const valid = await checkFreechargeCookies();
  if (!valid) {
    return res.status(401).json({ error: 'Author session invalid' });
  }
  const upiUri =
    `upi://pay?pa=${encodeURIComponent(UPI_ADDRESS)}` +
    `&pn=${encodeURIComponent(UPI_NAME)}` +
    `&am=${encodeURIComponent(amount)}` +
    `&tn=${encodeURIComponent(comment)}` +
    `&cu=INR`;
  try {
    const qrDataUrl = await QRCode.toDataURL(upiUri);
    res.json({
      qrDataUrl,
      COMMENT_FETCH_PER_SECONDS: Number(COMMENT_FETCH_PER_SECONDS)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed to generate QR' });
  }
});

app.get('/check', async (req, res) => {
  const { comment, amount } = req.query;
  if (!comment || !amount) {
    return res.status(400).json({ error: 'comment & amount required' });
  }
  try {
    const result = await findTransactionByComment(comment);
    if (result) {
      const { meta, txnDetails } = result;
      const ok = String(txnDetails.amount) === String(amount);
      return res.json({ success: ok, received: txnDetails.amount, meta, txnDetails });
    }
    return res.json({ success: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'check failed' });
  }
});

app.get('/verify', async (req, res) => {
  const { utr, comment, amount } = req.query;
  if (!utr || !comment || !amount) {
    return res.status(400).json({ error: 'utr, comment & amount required' });
  }
  try {
    const txns = await fetchTransactions();
    for (const txn of txns) {
      const meta = {};
      for (const section of txn.billerInfo?.billerMetaData || []) {
        for (const d of section.sectionDetails || []) {
          if (d.name) meta[d.name] = d.value || '';
        }
      }
      if (meta['UPI Transaction ID'] === utr) {
        const txnDetails = txn.txnDetails || {};
        const amtMatch = String(txnDetails.amount) === String(amount);
        const commentMatch = Object.values(meta).includes(comment);
        if (amtMatch && commentMatch) {
          return res.json({ success: true, received: txnDetails.amount, meta, txnDetails });
        }
        let reason = '';
        if (!amtMatch) reason += 'Amount mismatch. ';
        if (!commentMatch) reason += 'Comment mismatch.';
        return res.json({ success: false, message: reason.trim(), meta, txnDetails });
      }
    }
    res.json({ success: false, message: 'UTR not found' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'verify failed' });
  }
});

app.get('/:comment', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Payment‐server listening on http://localhost:${PORT}`);
});
