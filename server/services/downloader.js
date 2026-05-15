const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');

const MIN_SIZE = 11111;

const sources = (id) => ([
    { type: 'animated', url: `https://stickershop.line-scdn.net/stickershop/v1/product/${id}/iphone/stickerpack@2x.zip` },
    { type: 'emoji',    url: `https://stickershop.line-scdn.net/sticonshop/v1/${id}/sticon/iphone/package_animation.zip` },
    { type: 'static',   url: `https://stickershop.line-scdn.net/stickershop/v1/product/${id}/iphone/stickers@2x.zip` }
]);

const downloadZip = async (url, dest) => {
    const res = await fetch(url);
    await new Promise(r => res.body.pipe(fs.createWriteStream(dest)).on('finish', r));
    return fs.statSync(dest).size;
};

exports.download = async (packId) => {
    const root = path.join(__dirname, '../../data', packId);
    const zipPath = path.join(root, 'pack.zip');

    // clear previous download
    if (fs.existsSync(root)) {
        fs.rmSync(root, { recursive: true, force: true });
    }

    fs.mkdirSync(root, { recursive: true });

    let chosen;

    for (const s of sources(packId)) {
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

        const size = await downloadZip(s.url, zipPath);
        if (size >= MIN_SIZE) {
            chosen = s.type;
            break;
        }

        console.log(`NOT_FOUND: ${s.type} package ${packId}`);
    }

    new AdmZip(zipPath).extractAllTo(root, true);

    console.log(`Download ${chosen} pack ${packId} complete`);

    return { packId, type: chosen };
};