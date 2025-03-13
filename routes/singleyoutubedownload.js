const express = require('express');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Create router
const router = express.Router();

// Set up ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// Create temp directory for file processing
const tempDir = path.join(os.tmpdir(), 'youtube-downloader');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Store active download jobs
const activeJobs = new Map();

// Clean up old jobs every hour
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of activeJobs.entries()) {
    if (now - job.createdAt > 3600000) {
      cleanupFiles([job.videoPath, job.audioPath, job.outputPath]);
      activeJobs.delete(jobId);
    }
  }
}, 3600000);

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

// Process download
async function processDownload(jobId, url, format, audioFormat, videoPath, audioPath, outputPath) {
  try {
    const videoWriteStream = fs.createWriteStream(videoPath);
    const videoDownload = ytdl(url, { format });
    
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
  
    const job = activeJobs.get(jobId);
    if (!job) return;
    job.progress = 40;
  
    const audioWriteStream = fs.createWriteStream(audioPath);
    const audioDownload = ytdl(url, { format: audioFormat });
    
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
  
    const jobAfterAudio = activeJobs.get(jobId);
    if (!jobAfterAudio) return;
    jobAfterAudio.progress = 70;
  
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-strict experimental',
          '-stats_period 0.1'
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
  
    const jobAfterMerge = activeJobs.get(jobId);
    if (jobAfterMerge) {
      jobAfterMerge.progress = 100;
      jobAfterMerge.completed = true;
    }
  } catch (error) {
    console.error('Processing error:', error);
    
    const job = activeJobs.get(jobId);
    if (job) {
      job.error = error.message || 'Error processing video';
    }
    
    cleanupFiles([videoPath, audioPath, outputPath]);
  }
}

// Get video information endpoint
router.get('/info', async (req, res) => {
  try {
    const url = req.query.url;
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const info = await ytdl.getInfo(url);
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

// Start advanced download process
router.get('/download/start', async (req, res) => {
  try {
    const url = req.query.url;
    const itag = req.query.format;
    
    if (!ytdl.validateURL(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    const jobId = uuidv4();
    const info = await ytdl.getInfo(url);
    const format = info.formats.find(f => f.itag === parseInt(itag));
    
    if (!format) {
      return res.status(400).json({ error: 'Invalid format' });
    }
    
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
    const videoPath = path.join(tempDir, `${jobId}-video.${format.container}`);
    const audioPath = path.join(tempDir, `${jobId}-audio.mp4`);
    const outputPath = path.join(tempDir, `${jobId}-output.mp4`);
    
    const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
    
    if (!audioFormat) {
      return res.status(400).json({ error: 'No suitable audio format found' });
    }
    
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
    
    processDownload(jobId, url, format, audioFormat, videoPath, audioPath, outputPath);
    
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
router.get('/download/progress', (req, res) => {
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
router.get('/download/file', (req, res) => {
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
  
  res.header('Content-Disposition', `attachment; filename="${job.title}.mp4"`);
  fs.createReadStream(job.outputPath).pipe(res);
  
  setTimeout(() => {
    cleanupFiles([job.videoPath, job.audioPath, job.outputPath]);
    activeJobs.delete(jobId);
  }, 60000);
});

module.exports = router;