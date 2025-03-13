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

// Create router
const router = express.Router();

// Set up middleware
ffmpeg.setFfmpegPath(ffmpegPath);

// Create temp directory for file processing
const tempDir = path.join(os.tmpdir(), 'youtube-downloader');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Store batch jobs
const batchJobs = new Map();

// Batch processing queue to limit concurrent downloads
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

// Create a new batch download job
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

// Get all video info for a batch
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

// Start downloading a batch
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
        
        // Add to download queue
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

// Process a single download item in the batch
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
    // Update status to downloading
    item.status = 'downloading';
    
    // Get video information
    const info = await ytdl.getInfo(url);
    const selectedFormat = info.formats.find(f => f.itag === parseInt(format));
    
    if (!selectedFormat) {
      throw new Error('Selected format not available');
    }
    
    // Sanitize title for filename
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
    
    // Create output paths
    const videoPath = path.join(tempDir, `${jobId}-video.${selectedFormat.container}`);
    const audioPath = path.join(tempDir, `${jobId}-audio.mp4`);
    const outputPath = path.join(tempDir, `${jobId}-output.${selectedFormat.hasVideo ? 'mp4' : selectedFormat.container}`);
    
    // Store output path in the item
    item.outputPath = outputPath;
    
    // Different handling based on format type
    if (selectedFormat.hasVideo && !selectedFormat.hasAudio) {
      // Video-only format: need to download audio and merge
      const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
      
      if (!audioFormat) {
        throw new Error('No suitable audio format found');
      }
      
      // Download and process
      const videoStream = ytdl(url, { format: selectedFormat });
      const videoWriter = fs.createWriteStream(videoPath);
      
      // Track progress
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
      
      // Update progress
      item.progress = 40;
      updateBatchProgress(batchId);
      
      // Download audio
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
      
      // Update progress
      item.progress = 70;
      updateBatchProgress(batchId);
      
      // Merge video and audio
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
      
      // Clean up temporary files
      cleanupFiles([videoPath, audioPath]);
      
    } else if (selectedFormat.hasAudio) {
      // Format has audio (either audio-only or audio+video): direct download
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
    
    // Mark as completed
    item.status = 'completed';
    item.progress = 100;
    batchJob.completedItems++;
    
    // Update batch progress
    updateBatchProgress(batchId);
    
    return { success: true, itemId };
    
  } catch (error) {
    console.error(`Error processing item ${itemId}:`, error);
    
    // Update item with error
    item.status = 'error';
    item.error = error.message || 'Error processing download';
    item.progress = 0;
    batchJob.failedItems++;
    
    // Update batch progress
    updateBatchProgress(batchId);
    
    // Clean up any temporary files
    if (item.outputPath) {
      cleanupFiles([item.outputPath]);
      item.outputPath = null;
    }
    
    throw error;
  }
}
// Update batch job progress based on individual items
function updateBatchProgress(batchId) {
    if (!batchJobs.has(batchId)) return;
    
    const batchJob = batchJobs.get(batchId);
    
    // Calculate overall progress
    const totalProgress = batchJob.items.reduce((sum, item) => sum + item.progress, 0);
    batchJob.progress = totalProgress / batchJob.totalItems;
    
    // Check if all items are finished
    const pendingItems = batchJob.items.filter(item => 
      item.status === 'queued' || 
      item.status === 'downloading'
    ).length;
    
    if (pendingItems === 0) {
      batchJob.status = 'completed';
    }
  }
  
  // Get batch job status
  router.get('/status', (req, res) => {
    try {
      const { batchId } = req.query;
      
      if (!batchId || !batchJobs.has(batchId)) {
        return res.status(404).json({ error: 'Batch job not found' });
      }
      
      const batchJob = batchJobs.get(batchId);
      
      // Return batch status summary
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
  
  // Download completed batch as zip
  router.get('/download/zip', (req, res) => {
    try {
      const { batchId } = req.query;
      
      if (!batchId || !batchJobs.has(batchId)) {
        return res.status(404).json({ error: 'Batch job not found' });
      }
      
      const batchJob = batchJobs.get(batchId);
      
      // Check if batch has completed items
      const completedItems = batchJob.items.filter(item => 
        item.status === 'completed' && 
        item.outputPath && 
        fs.existsSync(item.outputPath)
      );
      
      if (completedItems.length === 0) {
        return res.status(400).json({ error: 'No completed downloads in this batch' });
      }
      
      // Create a zip file
      const zipPath = path.join(tempDir, `${batchId}-downloads.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 5 } });
      
      // Pipe archive to output file
      archive.pipe(output);
      
      // Add each file to the archive
      completedItems.forEach(item => {
        const fileExt = item.info && item.info.formats && item.info.formats.find(f => f.itag === item.format)?.container || 'mp4';
        const sanitizedTitle = item.info?.title?.replace(/[^\w\s]/gi, '') || `video-${item.id}`;
        archive.file(item.outputPath, { name: `${sanitizedTitle}.${fileExt}` });
      });
      
      // Finalize archive
      archive.finalize();
      
      // Return zip file when ready
      output.on('close', () => {
        res.download(zipPath, 'youtube-downloads.zip', err => {
          if (err) {
            console.error('Error sending zip file:', err);
          }
          // Clean up the zip file after a delay
          setTimeout(() => {
            if (fs.existsSync(zipPath)) {
              fs.unlinkSync(zipPath);
            }
          }, 60000);
        });
      });
      
      // Handle errors
      archive.on('error', err => {
        console.error('Error creating zip archive:', err);
        res.status(500).json({ error: 'Failed to create zip file' });
      });
    } catch (error) {
      console.error('Error downloading batch as zip:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Download a single completed item from a batch
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
      
      // Determine file extension
      const fileExt = item.info && item.info.formats && item.info.formats.find(f => f.itag === item.format)?.container || 'mp4';
      const sanitizedTitle = item.info?.title?.replace(/[^\w\s]/gi, '') || `video-${item.id}`;
      
      // Send the file
      res.download(item.outputPath, `${sanitizedTitle}.${fileExt}`);
    } catch (error) {
      console.error('Error downloading batch item:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Clean up a batch job (delete files and remove from memory)
  router.delete('/:batchId', (req, res) => {
    try {
      const { batchId } = req.params;
      
      if (!batchId || !batchJobs.has(batchId)) {
        return res.status(404).json({ error: 'Batch job not found' });
      }
      
      const batchJob = batchJobs.get(batchId);
      
      // Clean up all output files
      batchJob.items.forEach(item => {
        if (item.outputPath && fs.existsSync(item.outputPath)) {
          fs.unlinkSync(item.outputPath);
        }
      });
      
      // Remove batch job from memory
      batchJobs.delete(batchId);
      
      res.json({ message: 'Batch job deleted successfully' });
    } catch (error) {
      console.error('Error deleting batch job:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // Clean up old batch jobs every 6 hours
  setInterval(() => {
    const now = Date.now();
    for (const [batchId, batchJob] of batchJobs.entries()) {
      // Remove jobs older than 6 hours
      if (now - batchJob.createdAt > 6 * 3600000) {
        // Clean up files
        batchJob.items.forEach(item => {
          if (item.outputPath && fs.existsSync(item.outputPath)) {
            try {
              fs.unlinkSync(item.outputPath);
            } catch (err) {
              console.error('Error cleaning up batch file:', err);
            }
          }
        });
        
        // Remove from memory
        batchJobs.delete(batchId);
      }
    }
  }, 6 * 3600000);
  
  // Export the router
  module.exports = router;