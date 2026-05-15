const express = require('express');
const router = express.Router();
const downloader = require('../services/downloader');
const processor = require('../services/processor');
const fs = require('fs');

router.post('/download', async (req,res)=>{
  try{
    const result = await downloader.download(req.body.packId);
    res.json({result});
  }catch(e){res.status(500).json({error:e.toString()});}
});

router.post('/package', async (req,res)=>{
  try{
    const result = await processor.generate(req.body.packId);
    res.json({result});
  }catch(e){res.status(500).json({error:e.toString()});}
});


router.get('/healthcheck', (req, res) => {
  res.json({"status": "ok"});
});


router.get('/wastickers', (req, res) => {
  try {
    const file = Buffer.from(req.query.id, 'base64').toString();

    if (!file.startsWith('data') || !fs.existsSync(file)) {
      return res.status(404).send('Not found');
    }

    res.download(file);
  } catch(e) {
    res.status(400).send('Invalid request');
  }

});

module.exports = router;
