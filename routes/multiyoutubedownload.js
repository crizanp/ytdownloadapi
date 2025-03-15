const express = require('express');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Queue = require('better-queue');
const archiver = require('archiver');

const router = express.Router();

ffmpeg.setFfmpegPath(ffmpegPath);

const tempDir = path.join(os.tmpdir(), 'youtube-downloader');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const batchJobs = new Map();

const downloadQueue = new Queue(async function(task, callback) {
  try {
    await processDownloadItem(task);
    callback(null, { jobId: task.jobId, status: 'completed' });
  } catch (error) {
    console.error(`Error processing job ${task.jobId}:`, error);
    callback(error);
  }
}, { 
  concurrent: 3,
  maxRetries: 2,
  retryDelay: 3000
});

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

router.post('/batch/create', (req, res) => {
  try {
    const { urls, defaultFormat } = req.body;
    
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of URLs' });
    }
    
    const batchId = uuidv4();
    const batchJob = {
      id: batchId,
      items: [],
      status: 'created',
      progress: 0,
      createdAt: Date.now(),
      totalItems: urls.length,
      completedItems: 0,
      failedItems: 0
    };
    
    urls.forEach((url, index) => {
      if (typeof url === 'string' && ytdl.validateURL(url)) {
        batchJob.items.push({
          id: `${batchId}-${index}`,
          url,
          status: 'pending',
          progress: 0,
          format: defaultFormat || null,
          error: null,
          info: null,
          outputPath: null
        });
      } else {
        batchJob.items.push({
          id: `${batchId}-${index}`,
          url: url,
          status: 'error',
          error: 'Invalid YouTube URL',
          progress: 0
        });
        batchJob.failedItems++;
      }
    });
    
    batchJobs.set(batchId, batchJob);
    
    res.json({ 
      batchId, 
      message: 'Batch download job created',
      totalItems: batchJob.totalItems
    });
  } catch (error) {
    console.error('Error creating batch job:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/batch/info', async (req, res) => {
  try {
    const { batchId } = req.query;
    
    if (!batchId || !batchJobs.has(batchId)) {
      return res.status(404).json({ error: 'Batch job not found' });
    }
    
    const batchJob = batchJobs.get(batchId);
    batchJob.status = 'fetching_info';
    
    const fetchPromises = batchJob.items
      .filter(item => item.status === 'pending')
      .map(async (item) => {
        try {
          item.status = 'fetching_info';
          const info = await ytdl.getInfo(item.url);
          
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
          
          item.info = {
            title: info.videoDetails.title,
            formats,
            thumbnail: info.videoDetails.thumbnails[0].url,
            author: info.videoDetails.author,
            lengthSeconds: info.videoDetails.lengthSeconds
          };
          
          if (!item.format && formats.length > 0) {
            item.format = formats.find(f => f.hasVideo && f.hasAudio)?.itag || formats[0].itag;
          }
          
          item.status = 'ready';
          return { success: true, id: item.id };
        } catch (error) {
          console.error(`Error fetching info for ${item.url}:`, error);
          item.status = 'error';
          item.error = error.message || 'Failed to fetch video info';
          batchJob.failedItems++;
          return { success: false, id: item.id, error: error.message };
        }
      });
    
    await Promise.all(fetchPromises);
    
    const readyCount = batchJob.items.filter(item => item.status === 'ready').length;
    const errorCount = batchJob.items.filter(item => item.status === 'error').length;
    
    if (readyCount + errorCount === batchJob.totalItems) {
      batchJob.status = readyCount > 0 ? 'ready' : 'failed';
    }
    
    res.json({
      batchId,
      status: batchJob.status,
      totalItems: batchJob.totalItems,
      readyItems: readyCount,
      failedItems: errorCount
    });
  } catch (error) {
    console.error('Error processing batch info:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/batch/download', (req, res) => {
  try {
    const { batchId, formats } = req.body;
    
    if (!batchId || !batchJobs.has(batchId)) {
      return res.status(404).json({ error: 'Batch job not found' });
    }
    
    const batchJob = batchJobs.get(batchId);
    
    if (formats && typeof formats === 'object') {
      Object.entries(formats).forEach(([itemId, formatItag]) => {
        const item = batchJob.items.find(i => i.id === itemId);
        if (item && item.status === 'ready') {
          item.format = parseInt(formatItag);
        }
      });
    }
    
    batchJob.status = 'downloading';
    
    batchJob.items
      .filter(item => item.status === 'ready')
      .forEach(item => {
        item.status = 'queued';
        
        downloadQueue.push({
          jobId: item.id,
          url: item.url,
          format: item.format,
          batchId,
          itemId: item.id
        });
      });
    
    res.json({
      batchId,
      status: batchJob.status,
      message: 'Batch download started',
      totalItems: batchJob.totalItems,
      queuedItems: batchJob.items.filter(item => item.status === 'queued').length
    });
  } catch (error) {
    console.error('Error starting batch download:', error);
    res.status(500).json({ error: error.message });
  }
});

async function processDownloadItem(task) {
  const { jobId, url, format, batchId, itemId } = task;
  
  if (!batchJobs.has(batchId)) {
    throw new Error('Batch job not found');
  }
  
  const batchJob = batchJobs.get(batchId);
  const item = batchJob.items.find(i => i.id === itemId);
  
  if (!item) {
    throw new Error('Item not found in batch');
  }
  
  try {
    item.status = 'downloading';
    
    const info = await ytdl.getInfo(url);
    const selectedFormat = info.formats.find(f => f.itag === parseInt(format));
    
    if (!selectedFormat) {
      throw new Error('Selected format not available');
    }
    
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
    
    const videoPath = path.join(tempDir, `${jobId}-video.${selectedFormat.container}`);
    const audioPath = path.join(tempDir, `${jobId}-audio.mp4`);
    const outputPath = path.join(tempDir, `${jobId}-output.${selectedFormat.hasVideo ? 'mp4' : selectedFormat.container}`);
    
    item.outputPath = outputPath;
    
    if (selectedFormat.hasVideo && !selectedFormat.hasAudio) {
      const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
      
      if (!audioFormat) {
        throw new Error('No suitable audio format found');
      }
      
      const videoStream = ytdl(url, { format: selectedFormat });
      const videoWriter = fs.createWriteStream(videoPath);
      
      let videoTotalBytes = 0;
      let videoDownloadedBytes = 0;
      
      videoStream.on('response', (res) => {
        videoTotalBytes = parseInt(res.headers['content-length'], 10);
      });
      
      videoStream.on('data', (chunk) => {
        videoDownloadedBytes += chunk.length;
        if (videoTotalBytes > 0) {
          const videoProgress = (videoDownloadedBytes / videoTotalBytes) * 40;
          item.progress = Math.min(40, videoProgress);
          updateBatchProgress(batchId);
        }
      });
      
      videoStream.pipe(videoWriter);
      
      await new Promise((resolve, reject) => {
        videoWriter.on('finish', resolve);
        videoWriter.on('error', reject);
        videoStream.on('error', reject);
      });
      
      item.progress = 40;
      updateBatchProgress(batchId);
      
      const audioStream = ytdl(url, { format: audioFormat });
      const audioWriter = fs.createWriteStream(audioPath);
      
      let audioTotalBytes = 0;
      let audioDownloadedBytes = 0;
      
      audioStream.on('response', (res) => {
        audioTotalBytes = parseInt(res.headers['content-length'], 10);
      });
      
      audioStream.on('data', (chunk) => {
        audioDownloadedBytes += chunk.length;
        if (audioTotalBytes > 0) {
          const audioProgress = 40 + (audioDownloadedBytes / audioTotalBytes) * 30;
          item.progress = Math.min(70, audioProgress);
          updateBatchProgress(batchId);
        }
      });
      
      audioStream.pipe(audioWriter);
      
      await new Promise((resolve, reject) => {
        audioWriter.on('finish', resolve);
        audioWriter.on('error', reject);
        audioStream.on('error', reject);
      });
      
      item.progress = 70;
      updateBatchProgress(batchId);
      
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(videoPath)
          .input(audioPath)
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-strict experimental'
          ])
          .on('progress', (progress) => {
            const ffmpegProgress = progress.percent || 0;
            item.progress = 70 + (ffmpegProgress * 0.3);
            updateBatchProgress(batchId);
          })
          .on('end', resolve)
          .on('error', reject)
          .save(outputPath);
      });
      
      cleanupFiles([videoPath, audioPath]);
      
    } else if (selectedFormat.hasAudio) {
      const stream = ytdl(url, { format: selectedFormat });
      const writer = fs.createWriteStream(outputPath);
      
      let totalBytes = 0;
      let downloadedBytes = 0;
      
      stream.on('response', (res) => {
        totalBytes = parseInt(res.headers['content-length'], 10);
      });
      
      stream.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const progress = (downloadedBytes / totalBytes) * 100;
          item.progress = progress;
          updateBatchProgress(batchId);
        }
      });
      
      stream.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
        stream.on('error', reject);
      });
    }
    
    item.status = 'completed';
    item.progress = 100;
    batchJob.completedItems++;
    
    // Update batch progress
    updateBatchProgress(batchId);
    
    return { success: true, itemId };
    
  } catch (error) {
    console.error(`Error processing item ${itemId}:`, error);
    
    item.status = 'error';
    item.error = error.message || 'Error processing download';
    item.progress = 0;
    batchJob.failedItems++;
    
    updateBatchProgress(batchId);
    
   if (item.outputPath) {
      cleanupFiles([item.outputPath]);
      item.outputPath = null;
    }
    
    throw error;
  }
}
function updateBatchProgress(batchId) {
    if (!batchJobs.has(batchId)) return;
    
    const batchJob = batchJobs.get(batchId);
    
    const totalProgress = batchJob.items.reduce((sum, item) => sum + item.progress, 0);
    batchJob.progress = totalProgress / batchJob.totalItems;
    
    const pendingItems = batchJob.items.filter(item => 
      item.status === 'queued' || 
      item.status === 'downloading'
    ).length;
    
    if (pendingItems === 0) {
      batchJob.status = 'completed';
    }
  }
  
  router.get('/status', (req, res) => {
    try {
      const { batchId } = req.query;
      
      if (!batchId || !batchJobs.has(batchId)) {
        return res.status(404).json({ error: 'Batch job not found' });
      }
      
      const batchJob = batchJobs.get(batchId);
      
      res.json({
        batchId,
        status: batchJob.status,
        progress: batchJob.progress,
        totalItems: batchJob.totalItems,
        completedItems: batchJob.completedItems,
        failedItems: batchJob.failedItems,
        items: batchJob.items.map(item => ({
          id: item.id,
          url: item.url,
          status: item.status,
          progress: item.progress,
          error: item.error,
          title: item.info?.title || null
        }))
      });
    } catch (error) {
      console.error('Error getting batch status:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  router.get('/download/zip', (req, res) => {
    try {
      const { batchId } = req.query;
      
      if (!batchId || !batchJobs.has(batchId)) {
        return res.status(404).json({ error: 'Batch job not found' });
      }
      
      const batchJob = batchJobs.get(batchId);
      
      const completedItems = batchJob.items.filter(item => 
        item.status === 'completed' && 
        item.outputPath && 
        fs.existsSync(item.outputPath)
      );
      
      if (completedItems.length === 0) {
        return res.status(400).json({ error: 'No completed downloads in this batch' });
      }
      
      const zipPath = path.join(tempDir, `${batchId}-downloads.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 5 } });
      
      archive.pipe(output);
      
      completedItems.forEach(item => {
        const fileExt = item.info && item.info.formats && item.info.formats.find(f => f.itag === item.format)?.container || 'mp4';
        const sanitizedTitle = item.info?.title?.replace(/[^\w\s]/gi, '') || `video-${item.id}`;
        archive.file(item.outputPath, { name: `${sanitizedTitle}.${fileExt}` });
      });
      
      archive.finalize();
      
      output.on('close', () => {
        res.download(zipPath, 'youtube-downloads.zip', err => {
          if (err) {
            console.error('Error sending zip file:', err);
          }
          setTimeout(() => {
            if (fs.existsSync(zipPath)) {
              fs.unlinkSync(zipPath);
            }
          }, 60000);
        });
      });
      
      archive.on('error', err => {
        console.error('Error creating zip archive:', err);
        res.status(500).json({ error: 'Failed to create zip file' });
      });
    } catch (error) {
      console.error('Error downloading batch as zip:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  router.get('/download/item', (req, res) => {
    try {
      const { batchId, itemId } = req.query;
      
      if (!batchId || !batchJobs.has(batchId)) {
        return res.status(404).json({ error: 'Batch job not found' });
      }
      
      const batchJob = batchJobs.get(batchId);
      const item = batchJob.items.find(i => i.id === itemId);
      
      if (!item) {
        return res.status(404).json({ error: 'Item not found' });
      }
      
      if (item.status !== 'completed' || !item.outputPath || !fs.existsSync(item.outputPath)) {
        return res.status(400).json({ error: 'Item not ready for download' });
      }
      
      const fileExt = item.info && item.info.formats && item.info.formats.find(f => f.itag === item.format)?.container || 'mp4';
      const sanitizedTitle = item.info?.title?.replace(/[^\w\s]/gi, '') || `video-${item.id}`;
      
      res.download(item.outputPath, `${sanitizedTitle}.${fileExt}`);
    } catch (error) {
      console.error('Error downloading batch item:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  router.delete('/:batchId', (req, res) => {
    try {
      const { batchId } = req.params;
      
      if (!batchId || !batchJobs.has(batchId)) {
        return res.status(404).json({ error: 'Batch job not found' });
      }
      
      const batchJob = batchJobs.get(batchId);
      
      batchJob.items.forEach(item => {
        if (item.outputPath && fs.existsSync(item.outputPath)) {
          fs.unlinkSync(item.outputPath);
        }
      });
      
      batchJobs.delete(batchId);
      
      res.json({ message: 'Batch job deleted successfully' });
    } catch (error) {
      console.error('Error deleting batch job:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  setInterval(() => {
    const now = Date.now();
    for (const [batchId, batchJob] of batchJobs.entries()) {
      if (now - batchJob.createdAt > 6 * 3600000) {
        batchJob.items.forEach(item => {
          if (item.outputPath && fs.existsSync(item.outputPath)) {
            try {
              fs.unlinkSync(item.outputPath);
            } catch (err) {
              console.error('Error cleaning up batch file:', err);
            }
          }
        });
        
        batchJobs.delete(batchId);
      }
    }
  }, 6 * 3600000);
  
  module.exports = router;