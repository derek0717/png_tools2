const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const UPNG = require('@pdf-lib/upng').default;

const MAXWEBPSIZE = 500 * 1024;

/* ================= Helpers ================= */
function run(cmd) {
  execSync(cmd, { stdio: 'ignore' });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/* ---- Frame encode ---- */
function encodeFrameToWebP(inputPng, outputWebp, quality) {
  run(`cwebp -quiet -q ${quality} "${inputPng}" -o "${outputWebp}"`);
}

/* ---- Assemble ---- */
function assembleAnimatedWebP(frames, delays, outputFile, loop = 0) {
  if (!frames.length) throw new Error('No frames');


  function toWebpDelay(ms) {
    return Math.max(1, Math.round(ms / 10)); // convert ms → 1/100s units
  }

  let cmd = `webpmux -frame "${frames[0]}" +${toWebpDelay(delays[0])}+0+0+1`;

  for (let i = 1; i < frames.length; i++) {
    cmd += ` -frame "${frames[i]}" +${toWebpDelay(delays[i])}+0+0+1`;
  }

  cmd += ` -loop ${loop} -o "${outputFile}"`;

  run(cmd);
}

function getSquareFrame(frame, w, h) {
  if (w === h) return frame;

  const pixel = new Uint8Array([0, 0, 0, 0]); // transparent

  let size = Math.max(w, h);
  let output = new Uint8Array(size * size * 4);

  if (w > h) {
    // pad top/bottom
    const top = Math.floor((w - h) / 2);

    for (let y = 0; y < h; y++) {
      const srcStart = y * w * 4;
      const dstStart = (y + top) * w * 4;
      output.set(frame.subarray(srcStart, srcStart + w * 4), dstStart);
    }

  } else {
    // pad left/right
    const left = Math.floor((h - w) / 2);

    for (let y = 0; y < h; y++) {
      const srcStart = y * w * 4;
      const dstStart = (y * h + left) * 4;
      output.set(frame.subarray(srcStart, srcStart + w * 4), dstStart);
    }
  }

  return { data: output, size };
}

/* ---- Extract frames ---- */
function extractFrames(input, tmpDir) {

  const buffer = fs.readFileSync(input);

  // decode APNG properly
  const img = UPNG.decode(buffer);

  const width = img.width;
  const height = img.height;

  // true frame delays
  const delays = img.frames.map(f => f.delay * 10);

  function resizeTo512(rgba, w, h) {
    const target = 512;

    const scale = Math.min(target / w, target / h);
    const nw = Math.round(w * scale);
    const nh = Math.round(h * scale);

    const out = new Uint8Array(target * target * 4);

    // fill transparent
    for (let i = 0; i < out.length; i++) out[i] = 0;

    const offsetX = Math.floor((target - nw) / 2);
    const offsetY = Math.floor((target - nh) / 2);

    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {

        const srcX = Math.floor(x / scale);
        const srcY = Math.floor(y / scale);

        const srcIdx = (srcY * w + srcX) * 4;
        const dstIdx = ((y + offsetY) * target + (x + offsetX)) * 4;

        out[dstIdx] = rgba[srcIdx];
        out[dstIdx + 1] = rgba[srcIdx + 1];
        out[dstIdx + 2] = rgba[srcIdx + 2];
        out[dstIdx + 3] = rgba[srcIdx + 3];
      }
    }

    return { data: out, size: 512 };
  }

  const rgbaFrames = UPNG.toRGBA8(img);

  // write each frame as PNG (512x512 with padding)

  rgbaFrames.forEach((frameBuf, i) => {

    const frame = new Uint8Array(frameBuf);

    const sq = getSquareFrame(frame, width, height);

    // SCALE to 512 using UPNG (safe method)
    const png = UPNG.encode(
        [sq.data],
        sq.size,
        sq.size,
        0
    );

    const framePath = path.join(
        tmpDir,
        `frame_${String(i).padStart(4, '0')}.png`
    );

    fs.writeFileSync(framePath, Buffer.from(png));
    run(`sips -z 512 512 "${framePath}" --out "${framePath}"`);
  });
  return delays;
}

/* ---- Core encoder ---- */
function encodeAnimatedWebP(frameDir, outputFile, delays) {
  const files = fs.readdirSync(frameDir)
      .filter(f => f.endsWith('.png'))
      .sort();

  const qualityLevels = [90, 80, 70, 60, 50, 40, 30];
  const frameSkips = [1, 2, 3];

  for (const skip of frameSkips) {

    let selected = files.filter((_, i) => i % skip === 0);
    if (!selected.length) selected = [files[0]];

    for (const q of qualityLevels) {

      const tempWebps = [];

      selected.forEach((file, i) => {
        const input = path.join(frameDir, file);
        const out = path.join(frameDir, `tmp_${i}.webp`);

        encodeFrameToWebP(input, out, q);
        tempWebps.push(out);
      });

      const adjusted = [];
      for (let i = 0; i < selected.length; i++) {
        let start = i * skip;
        let sum = 0;

        for (let j = 0; j < skip; j++) {
          if (delays[start + j]) sum += delays[start + j];
        }

        adjusted.push(sum);
      }

      try {
        assembleAnimatedWebP(tempWebps, adjusted, outputFile);

        if (fs.existsSync(outputFile)) {
          const size = fs.statSync(outputFile).size;

          if (size <= MAXWEBPSIZE) {
            tempWebps.forEach(f => fs.unlinkSync(f));
            return outputFile;
          }
        }
      } catch {}

      tempWebps.forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
    }
  }

  throw new Error('Failed to compress under 500KB');
}

function resolveMeta(baseDir, stickerId) {
  const metaPath = path.join(baseDir, 'productInfo.meta');

  let title = String(stickerId);
  let author = 'LINE';

  try {
    if (fs.existsSync(metaPath)) {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw);

      // title priority: zh-Hant → en
      if (meta.title) {
        title =
            meta.title['zh-Hant'] ||
            meta.title['en'] ||
            title;
      }

      // author priority: zh-Hant → en
      if (meta.author) {
        author =
            meta.author['zh-Hant'] ||
            meta.author['en'] ||
            author;
      }
    }
  } catch (e) {
    // fallback silently
  }

  return { title, author };
}


/* ================= Main ================= */
exports.generate = async (stickerId) => {
  const baseDir = path.join('data', String(stickerId));
  const animDir = path.join(baseDir, 'animation@2x');
  const outputDir = path.join(baseDir, 'output');
  const tmpDir = path.join(baseDir, 'tmp');

  ensureDir(outputDir);
  ensureDir(tmpDir);

  const meta = resolveMeta(baseDir, stickerId);
  const title = meta.title;
  const author = meta.author;

  const files = fs.readdirSync(animDir).filter(f => f.endsWith('.png'));

  for (const file of files) {
    const input = path.join(animDir, file);

    const stickerTmp = path.join(tmpDir, file.replace('.png', ''));
    ensureDir(stickerTmp);

    const delays = extractFrames(input, stickerTmp);

    const outputName = file.replace('.png', '.webp');
    const output = path.join(outputDir, outputName);

    encodeAnimatedWebP(stickerTmp, output, delays);

    console.log(`Processed ${outputName}`);

    fs.rmSync(stickerTmp, { recursive: true, force: true });
  }

  fs.writeFileSync(path.join(outputDir, 'title.txt'), title);
  fs.writeFileSync(path.join(outputDir, 'author.txt'), author);

  function processTray(inputPath, outputPath) {
    const buffer = fs.readFileSync(inputPath);

    const img = UPNG.decode(buffer);
    const width = img.width;
    const height = img.height;

    const rgba = UPNG.toRGBA8(img)[0]; // tray is static → first frame

    const frame = new Uint8Array(rgba);

    const sq = getSquareFrame(frame, width, height);
    const tmpSquare = outputPath + '.tmp.png';

    // write square PNG (still original size)
    fs.writeFileSync(
        tmpSquare,
        Buffer.from(UPNG.encode([sq.data], sq.size, sq.size, 0))
    );

    run(`sips -z 96 96 "${tmpSquare}" --out "${outputPath}"`);

    fs.unlinkSync(tmpSquare);
  }

  const traySrc = path.join(baseDir, 'tab_on@2x.png');
  const trayOut = path.join(outputDir, 'tray.png');
  processTray(traySrc, trayOut);

  const zip = new AdmZip();
  fs.readdirSync(outputDir).forEach(f => {
    zip.addLocalFile(path.join(outputDir, f));
  });

  const outFile = path.join(baseDir, `${stickerId}.wastickers`);
  zip.writeZip(outFile);

  // clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`Processed pack ${stickerId}`)

  return outFile;
};