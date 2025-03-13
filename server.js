const express = require('express');
const cors = require('cors');
const youtubeRouter = require('./routes/singleyoutubedownload');
const youtubeDownloaderRouter = require('./routes/multiyoutubedownload');

const app = express();

// Set up middleware
app.use(cors());
app.use(express.json());

// Use the YouTube downloader router for all '/api' routes
app.use('/api/singleytdownload', youtubeRouter);
app.use('/api/batchytdownload', youtubeDownloaderRouter);

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});