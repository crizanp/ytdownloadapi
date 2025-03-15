// server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const url = require('url');

const app = express();
app.use(cors());

const extractDomain = (urlString) => {
  try {
    const parsedUrl = new URL(urlString);
    return parsedUrl.hostname;
  } catch (e) {
    return urlString;
  }
};

const getRandomUserAgent = () => {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

app.get('/api/analyze', async (req, res) => {
  try {
    let targetUrl = req.query.url;
    if (!targetUrl.startsWith('http')) {
      targetUrl = `https://${targetUrl}`;
    }
    
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://www.google.com/',
        'DNT': '1'
      },
      timeout: 10000, // 10 second timeout
      maxRedirects: 5
    });
    
    const $ = cheerio.load(response.data);
    
    const scripts = [];
    $('script').each((_, element) => {
      const src = $(element).attr('src');
      if (src) scripts.push(src);
    });
    
    const stylesheets = [];
    $('link[rel="stylesheet"]').each((_, element) => {
      const href = $(element).attr('href');
      if (href) stylesheets.push(href);
    });
    
    const metaTags = {};
    $('meta').each((_, element) => {
      const name = $(element).attr('name') || $(element).attr('property');
      const content = $(element).attr('content');
      if (name && content) metaTags[name] = content;
    });
    
    const favicons = [];
    $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').each((_, element) => {
      const href = $(element).attr('href');
      if (href) favicons.push(href);
    });
    
    res.json({
      url: targetUrl,
      domain: extractDomain(targetUrl),
      title: $('title').text(),
      html: response.data,
      headers: response.headers,
      scripts,
      stylesheets,
      metaTags,
      favicons,
      statusCode: response.status
    });
  } catch (error) {
    console.error('Error analyzing website:', error.message);
    
    const errorResponse = {
      error: 'Failed to fetch website',
      details: error.message
    };
    
    if (error.response) {
      errorResponse.statusCode = error.response.status;
      errorResponse.statusText = error.response.statusText;
    } else if (error.request) {
      errorResponse.networkError = true;
    }
    
    res.status(500).json(errorResponse);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));