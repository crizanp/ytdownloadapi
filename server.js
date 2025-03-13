const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Worker } = require('worker_threads');
const Queue = require('better-queue'); // npm install better-queue
const archiver = require('archiver'); // npm install archiver

const app = express();

// Set up middleware
ffmpeg.setFfmpegPath(ffmpegPath);
app.use(cors());
app.use(express.json());

// Create temp directory for file processing
const tempDir = path.join(os.tmpdir(), 'youtube-downloader');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Common request options to avoid bot detection
const requestOptions = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cookie': process.env.YOUTUBE_COOKIES || '' // Set cookies from environment variable
  }
};

// ==========================================
// SHARED UTILITIES
// ==========================================

// Clean up function to remove files
function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error('Error cleaning up file:', filePath, err);
      }
    }
  }
}

// ==========================================
// SINGLE DOWNLOAD IMPLEMENTATION
// ==========================================

// Store active download jobs
const activeJobs = new Map();

// Clean up old jobs every hour
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of activeJobs.entries()) {
    // Remove jobs older than 1 hour
    if (now - job.createdAt > 3600000) {
      cleanupFiles([job.videoPath, job.audioPath, job.outputPath]);
      activeJobs.delete(jobId);
    }
  }
}, 3600000);

// Get video information endpoint
app.get('/api/info', async (req, res) => {
  try {
    const url = req.query.url;
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(url, { requestOptions });
    const formats = info.formats
      .filter(f => f.qualityLabel || f.audioQuality)
      .map(format => ({
        itag: format.itag,
        qualityLabel: format.qualityLabel || 'Audio',
        container: format.container,
        hasVideo: format.hasVideo,
        hasAudio: format.hasAudio,
        audioQuality: format.audioQuality,
        contentLength: format.contentLength
      }))
      .sort((a, b) => {
        const aQuality = parseInt(a.qualityLabel) || 0;
        const bQuality = parseInt(b.qualityLabel) || 0;
        return bQuality - aQuality;
      });

    res.json({
      title: info.videoDetails.title,
      formats,
      thumbnail: info.videoDetails.thumbnails[0].url,
      author: info.videoDetails.author,
      lengthSeconds: info.videoDetails.lengthSeconds
    });
  } catch (error) {
    console.error('Error fetching video info:', error);
    res.status(500).json({ error: error.message });
  }
});

// Original download endpoint for direct downloads (audio-only or video+audio)
app.get('/api/download', async (req, res) => {
  try {
    const url = req.query.url;
    const itag = req.query.format;

    if (!ytdl.validateURL(url)) {
      return res.status(400).send('Invalid YouTube URL');
    }

    const info = await ytdl.getInfo(url, { requestOptions });
    const format = info.formats.find(f => f.itag === parseInt(itag));
    if (!format) return res.status(400).send('Invalid format');

    // Sanitize title for filename
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');

    // Only handle formats with both audio and video or audio-only here
    if ((format.hasAudio && format.hasVideo) || (format.hasAudio && !format.hasVideo)) {
      res.header('Content-Disposition', `attachment; filename="${title}.${format.container}"`);
      // Set headers for proper progress reporting
      if (format.contentLength) {
        res.header('Content-Length', format.contentLength);
      }
      ytdl(url, { format, requestOptions }).pipe(res);
    } else {
      // For video-only formats, redirect to the new endpoint system
      res.status(400).send('Please use /api/download/start for video-only formats');
    }
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).send(error.message);
  }
});

// Start advanced download process
app.get('/api/download/start', async (req, res) => {
  try {
    const url = req.query.url;
    const itag = req.query.format;
    
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    // Create a unique ID for this job
    const jobId = uuidv4();
    
    // Get video information
    const info = await ytdl.getInfo(url, { requestOptions });
    const format = info.formats.find(f => f.itag === parseInt(itag));
    
    if (!format) {
      return res.status(400).json({ error: 'Invalid format' });
    }
    
    // Sanitize title for filename
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
    
    // Create file paths
    const videoPath = path.join(tempDir, `${jobId}-video.${format.container}`);
    const audioPath = path.join(tempDir, `${jobId}-audio.mp4`);
    const outputPath = path.join(tempDir, `${jobId}-output.mp4`);
    
    // Find best audio format
    const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
    
    if (!audioFormat) {
      return res.status(400).json({ error: 'No suitable audio format found' });
    }
    
    // Create job entry
    activeJobs.set(jobId, {
      id: jobId,
      url,
      progress: 0,
      completed: false,
      error: null,
      videoPath,
      audioPath,
      outputPath,
      title,
      createdAt: Date.now()
    });
    
    // Start the download process in the background
    processDownload(jobId, url, format, audioFormat, videoPath, audioPath, outputPath);
    
    // Send the job ID to the client immediately
    res.json({
      jobId,
      message: 'Download started'
    });
    
  } catch (error) {
    console.error('Error starting download:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check the progress of a download job
app.get('/api/download/progress', (req, res) => {
  const { jobId } = req.query;
  
  if (!jobId || !activeJobs.has(jobId)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  const job = activeJobs.get(jobId);
  res.json({
    progress: job.progress,
    completed: job.completed,
    error: job.error
  });
});

// Download the completed file
app.get('/api/download/file', (req, res) => {
  const { jobId } = req.query;
  
  if (!jobId || !activeJobs.has(jobId)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  const job = activeJobs.get(jobId);
  
  if (!job.completed) {
    return res.status(400).json({ error: 'Job not completed yet' });
  }
  
  if (job.error) {
    return res.status(500).json({ error: job.error });
  }
  
  if (!fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'Output file not found' });
  }
  
  // Set headers for file download
  res.header('Content-Disposition', `attachment; filename="${job.title}.mp4"`);
  
  // Stream the file
  fs.createReadStream(job.outputPath).pipe(res);
  
  // Clean up files after a delay
  setTimeout(() => {
    cleanupFiles([job.videoPath, job.audioPath, job.outputPath]);
    activeJobs.delete(jobId);
  }, 60000); // 1 minute delay to ensure file is properly streamed
});

// Process download (extracted for reuse in batch processing)
async function processDownload(jobId, url, format, audioFormat, videoPath, audioPath, outputPath) {
  try {
    // Download video with progress tracking
    const videoWriteStream = fs.createWriteStream(videoPath);
    const videoDownload = ytdl(url, { format, requestOptions });
    
    let videoTotalBytes = 0;
    let videoDownloadedBytes = 0;
    
    videoDownload.on('response', (res) => {
      videoTotalBytes = parseInt(res.headers['content-length'], 10);
    });
    
    let lastVideoProgressUpdate = Date.now();
    videoDownload.on('data', (chunk) => {
      videoDownloadedBytes += chunk.length;
      
      if (videoTotalBytes > 0) {
        const now = Date.now();
        // Update progress max every 100ms
        if (now - lastVideoProgressUpdate >= 100) {
          const videoProgress = (videoDownloadedBytes / videoTotalBytes) * 40;
          const job = activeJobs.get(jobId);
          if (job) job.progress = Math.min(40, videoProgress);
          lastVideoProgressUpdate = now;
        }
      }
    });
  
    videoDownload.pipe(videoWriteStream);
  
    await new Promise((resolve, reject) => {
      videoWriteStream.on('finish', resolve);
      videoWriteStream.on('error', reject);
      videoDownload.on('error', reject);
    });
  
    // Update job progress after video download completes
    const job = activeJobs.get(jobId);
    if (!job) return; // Job might have been removed
    job.progress = 40;
  
    // Download audio with progress tracking
    const audioWriteStream = fs.createWriteStream(audioPath);
    const audioDownload = ytdl(url, { format: audioFormat, requestOptions });
    
    let audioTotalBytes = 0;
    let audioDownloadedBytes = 0;
    
    audioDownload.on('response', (res) => {
      audioTotalBytes = parseInt(res.headers['content-length'], 10);
    });
    
    let lastAudioProgressUpdate = Date.now();
    audioDownload.on('data', (chunk) => {
      audioDownloadedBytes += chunk.length;
      
      if (audioTotalBytes > 0) {
        const now = Date.now();
        // Update progress max every 100ms
        if (now - lastAudioProgressUpdate >= 100) {
          const audioProgress = 40 + (audioDownloadedBytes / audioTotalBytes) * 30;
          const job = activeJobs.get(jobId);
          if (job) job.progress = Math.min(70, audioProgress);
          lastAudioProgressUpdate = now;
        }
      }
    });
  
    audioDownload.pipe(audioWriteStream);
  
    await new Promise((resolve, reject) => {
      audioWriteStream.on('finish', resolve);
      audioWriteStream.on('error', reject);
      audioDownload.on('error', reject);
    });
  
    // Update job progress after audio download completes
    const jobAfterAudio = activeJobs.get(jobId);
    if (!jobAfterAudio) return; // Job might have been removed
    jobAfterAudio.progress = 70;
  
    // Merge video and audio using ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-strict experimental',
          '-stats_period 0.1' // More frequent progress updates
        ])
        .on('progress', (progress) => {
          const jobDuringMerge = activeJobs.get(jobId);
          if (jobDuringMerge) {
            const ffmpegProgress = progress.percent || 0;
            jobDuringMerge.progress = 70 + (ffmpegProgress * 0.3);
          }
        })
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });
  
    // Update job as completed
    const jobAfterMerge = activeJobs.get(jobId);
    if (jobAfterMerge) {
      jobAfterMerge.progress = 100;
      jobAfterMerge.completed = true;
    }
  } catch (error) {
    console.error('Processing error:', error);
    
    // Update job with error
    const job = activeJobs.get(jobId);
    if (job) {
      job.error = error.message || 'Error processing video';
    }
    
    // Clean up temp files on error
    cleanupFiles([videoPath, audioPath, outputPath]);
  }
}

// Add a health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Service is running' });
});

// Add an API endpoint for providing YouTube cookies
app.post('/api/set-cookies', (req, res) => {
  const { cookies } = req.body;
  
  if (!cookies) {
    return res.status(400).json({ error: 'No cookies provided' });
  }
  
  // Update request options with the new cookies
  requestOptions.headers.Cookie = cookies;
  
  res.json({ success: true, message: 'Cookies updated successfully' });
});

// Add endpoint to clear temporary files
app.post('/api/maintenance/cleanup', (req, res) => {
  let cleanedCount = 0;
  try {
    fs.readdir(tempDir, (err, files) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      files.forEach(file => {
        const filePath = path.join(tempDir, file);
        fs.unlinkSync(filePath);
        cleanedCount++;
      });
      
      res.json({ success: true, message: `Cleaned up ${cleanedCount} files` });
    });
  } catch (error) {
    res.status(500).json({ error: error.message, cleaned: cleanedCount });
  }
});

// ==========================================
// VERCEL OPTIMIZATION
// ==========================================

// Check if running on Vercel
const isVercel = process.env.VERCEL === '1';

if (isVercel) {
  // Add route for Vercel serverless function detection
  app.get('/api/vercel-ready', (req, res) => {
    res.json({ 
      ready: true,
      environment: 'vercel',
      message: 'This app has limited functionality on Vercel due to serverless function limitations. Consider using a different hosting provider for better performance.'
    });
  });
  
  // Override download endpoints with a more appropriate message for Vercel
  app.get('/api/download', (req, res) => {
    res.status(400).json({ 
      error: 'Direct downloads are not supported on Vercel due to serverless function timeout limits. Please use a different hosting provider.',
      suggestion: 'Consider deploying this app to Heroku, Railway, or a VPS for full functionality.'
    });
  });
  
  app.get('/api/download/start', (req, res) => {
    res.status(400).json({ 
      error: 'Advanced downloads are not supported on Vercel due to serverless function timeout limits. Please use a different hosting provider.',
      suggestion: 'Consider deploying this app to Heroku, Railway, or a VPS for full functionality.'
    });
  });
}

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;