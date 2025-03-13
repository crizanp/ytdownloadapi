const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');

const app = express();

// Set up middleware
app.use(cors());
app.use(express.json());

// ==========================================
// API ENDPOINTS
// ==========================================

// Get video information endpoint
app.get('/api/info', async (req, res) => {
  try {
    const url = req.query.url;
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(url);
    
    // Format information for client
    const formats = info.formats
      .filter(f => f.qualityLabel || f.audioQuality)
      .map(format => ({
        itag: format.itag,
        qualityLabel: format.qualityLabel || 'Audio Only',
        container: format.container,
        hasVideo: format.hasVideo,
        hasAudio: format.hasAudio,
        audioQuality: format.audioQuality,
        contentLength: format.contentLength,
        mimeType: format.mimeType
      }))
      .sort((a, b) => {
        // Sort video formats by quality
        const aQuality = parseInt(a.qualityLabel) || 0;
        const bQuality = parseInt(b.qualityLabel) || 0;
        return bQuality - aQuality;
      });

    res.json({
      title: info.videoDetails.title,
      formats,
      thumbnail: info.videoDetails.thumbnails[0].url,
      author: info.videoDetails.author.name,
      lengthSeconds: info.videoDetails.lengthSeconds
    });
  } catch (error) {
    console.error('Error fetching video info:', error);
    res.status(500).json({ error: error.message });
  }
});

// Direct download endpoint
app.get('/api/download', async (req, res) => {
  try {
    const url = req.query.url;
    const itag = req.query.format;

    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(url);
    const format = info.formats.find(f => f.itag === parseInt(itag));
    
    if (!format) {
      return res.status(400).json({ error: 'Invalid format' });
    }

    // Create safe filename from video title
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
    const fileExtension = format.container || 'mp4';
    
    // Set appropriate response headers
    res.header('Content-Disposition', `attachment; filename="${title}.${fileExtension}"`);
    
    // For formats that have a direct URL, redirect to it
    if (format.url) {
      return res.redirect(format.url);
    }
    
    // For formats requiring decryption or without a direct URL, use ytdl
    ytdl(url, { format }).pipe(res);
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stream proxy endpoint - client can use this to play media directly
app.get('/api/stream', async (req, res) => {
  try {
    const url = req.query.url;
    const itag = req.query.format;

    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const stream = ytdl(url, { quality: itag });
    stream.pipe(res);
    
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Handle root path to serve a simple frontend
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>YouTube Downloader</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: Arial, sans-serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          line-height: 1.6;
        }
        .container {
          background-color: #f9f9f9;
          border-radius: 8px;
          padding: 20px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
          color: #cc0000;
        }
        input, button, select {
          padding: 10px;
          margin: 10px 0;
          width: 100%;
          border-radius: 4px;
          border: 1px solid #ddd;
        }
        button {
          background-color: #cc0000;
          color: white;
          border: none;
          cursor: pointer;
        }
        button:hover {
          background-color: #990000;
        }
        #results {
          margin-top: 20px;
        }
        .format-option {
          background-color: white;
          padding: 10px;
          margin: 5px 0;
          border-radius: 4px;
          border: 1px solid #ddd;
        }
        .thumbnail {
          max-width: 100%;
          height: auto;
          border-radius: 4px;
          margin: 10px 0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>YouTube Downloader</h1>
        <p>Enter a YouTube URL to get download options</p>
        
        <input type="text" id="videoUrl" placeholder="https://www.youtube.com/watch?v=..." />
        <button id="fetchInfo">Get Download Options</button>
        
        <div id="results"></div>
      </div>

      <script>
        document.getElementById('fetchInfo').addEventListener('click', async () => {
          const url = document.getElementById('videoUrl').value.trim();
          const resultsDiv = document.getElementById('results');
          
          if (!url) {
            resultsDiv.innerHTML = '<p style="color: red">Please enter a YouTube URL</p>';
            return;
          }
          
          resultsDiv.innerHTML = '<p>Loading...</p>';
          
          try {
            const response = await fetch(\`/api/info?url=\${encodeURIComponent(url)}\`);
            const data = await response.json();
            
            if (response.ok) {
              // Display video info and download options
              let html = \`
                <h2>\${data.title}</h2>
                <p>By \${data.author}</p>
                <img src="\${data.thumbnail}" alt="Video thumbnail" class="thumbnail" />
                <h3>Download Options</h3>
              \`;
              
              data.formats.forEach(format => {
                const formatName = format.hasVideo
                  ? \`\${format.qualityLabel} (\${format.container})\`
                  : \`Audio Only (\${format.audioQuality || 'Standard'} quality)\`;
                  
                html += \`
                  <div class="format-option">
                    <div>\${formatName}</div>
                    <a href="/api/download?url=\${encodeURIComponent(url)}&format=\${format.itag}" target="_blank">
                      <button>Download</button>
                    </a>
                  </div>
                \`;
              });
              
              resultsDiv.innerHTML = html;
            } else {
              resultsDiv.innerHTML = \`<p style="color: red">Error: \${data.error}</p>\`;
            }
          } catch (error) {
            console.error('Error:', error);
            resultsDiv.innerHTML = '<p style="color: red">An error occurred. Please try again.</p>';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// Catch-all route for SPA
app.get('*', (req, res) => {
  res.redirect('/');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Export for Vercel
module.exports = app;