const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const UPNG = require('@pdf-lib/upng').default;

const MAX = 500 * 1024;

/* ========= base utils ========= */
const run = c => execSync(c, { stdio: 'ignore' });
const mkdir = d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true });

const toDelay = ms => Math.max(1, Math.round(ms / 10));

/* ========= webp ========= */
const webp_encode = (i, o, q = 90) =>
    run(`cwebp -quiet -q ${q} "${i}" -o "${o}"`);

const webp_assemble = (frames, delays, out) => {
    if (!frames.length) throw new Error('No frames');

    let cmd = `webpmux -frame "${frames[0]}" +${toDelay(delays[0])}+0+0+1`;

    for (let i = 1; i < frames.length; i++)
        cmd += ` -frame "${frames[i]}" +${toDelay(delays[i])}+0+0+1`;

    run(`${cmd} -loop 0 -o "${out}"`);
};

/* ========= image (shared) ========= */
const image_padSquare = (buf, w, h) => {
    if (w === h) return { data: buf, size: w };

    const size = Math.max(w, h);
    const out = new Uint8Array(size * size * 4);

    if (w > h) {
        const top = (w - h) >> 1;
        for (let y = 0; y < h; y++) {
            const s = y * w * 4;
            const d = (y + top) * w * 4;
            out.set(buf.subarray(s, s + w * 4), d);
        }
    } else {
        const left = (h - w) >> 1;
        for (let y = 0; y < h; y++) {
            const s = y * w * 4;
            const d = (y * h + left) * 4;
            out.set(buf.subarray(s, s + w * 4), d);
        }
    }

    return { data: out, size };
};

/* ========= animated pipeline ========= */
const animated_extractFrames = (input, dir) => {
    const img = UPNG.decode(fs.readFileSync(input));
    const { width: w, height: h } = img;

    const delays = img.frames.map(f => f.delay * 10);
    const frames = UPNG.toRGBA8(img);

    frames.forEach((f, i) => {
        const { data, size } = image_padSquare(new Uint8Array(f), w, h);

        const out = path.join(dir, `frame_${String(i).padStart(4, '0')}.png`);

        fs.writeFileSync(out, Buffer.from(UPNG.encode([data], size, size, 0)));
        run(`sips -z 512 512 "${out}" --out "${out}"`);
    });

    return delays;
};

const animated_encode = (dir, out, delays) => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();

    for (const skip of [1, 2, 3]) {
        let selected = files.filter((_, i) => i % skip === 0);
        if (!selected.length) selected = [files[0]];

        for (const q of [90,80,70,60,50,40,30]) {
            const tmp = selected.map((f, i) => {
                const o = path.join(dir, `tmp_${i}.webp`);
                webp_encode(path.join(dir, f), o, q);
                return o;
            });

            const adj = selected.map((_, i) => {
                let sum = 0;
                for (let j = 0; j < skip; j++)
                    if (delays[i * skip + j]) sum += delays[i * skip + j];
                return sum;
            });

            try {
                webp_assemble(tmp, adj, out);
                if (fs.existsSync(out) && fs.statSync(out).size <= MAX) {
                    tmp.forEach(f => fs.unlinkSync(f));
                    return out;
                }
            } catch {}

            tmp.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));
        }
    }

    throw new Error('Failed to compress under 500KB');
};

/* ========= static pipeline ========= */
const static_processImage = (input, output) => {
    const img = UPNG.decode(fs.readFileSync(input));
    const rgba = UPNG.toRGBA8(img)[0];

    const { data, size } = image_padSquare(
        new Uint8Array(rgba),
        img.width,
        img.height
    );

    const tmp = output + '.tmp.png';

    fs.writeFileSync(tmp, Buffer.from(UPNG.encode([data], size, size, 0)));
    run(`sips -z 512 512 "${tmp}" --out "${tmp}"`);

    webp_encode(tmp, output, 90);
    fs.unlinkSync(tmp);
};

/* ========= meta ========= */
const meta_resolve = (baseDir, id) => {
    const p = path.join(baseDir, 'productInfo.meta');
    let title = String(id);
    let author = 'LINE';

    try {
        if (fs.existsSync(p)) {
            const m = JSON.parse(fs.readFileSync(p, 'utf-8'));

            if (m.title)
                title = m.title['zh-Hant'] || m.title['en'] || title;

            if (m.author)
                author = m.author['zh-Hant'] || m.author['en'] || author;
        }
    } catch {}

    return { title, author };
};

/* ========= tray ========= */
const tray_process = (input, out) => {
    const img = UPNG.decode(fs.readFileSync(input));
    const rgba = UPNG.toRGBA8(img)[0];

    const { data, size } = image_padSquare(
        new Uint8Array(rgba),
        img.width,
        img.height
    );

    const tmp = out + '.tmp.png';
    fs.writeFileSync(tmp, Buffer.from(UPNG.encode([data], size, size, 0)));

    run(`sips -z 96 96 "${tmp}" --out "${out}"`);
    fs.unlinkSync(tmp);
};

/* ===== packaging ===== */
const packageStickers = (base, outDir, id, title, author) => {
    const all = fs.readdirSync(outDir)
        .filter(f => f.endsWith('.webp') && f !== 'tray.webp')
        .sort();

    if (!all.length) throw new Error('No stickers generated');

    while (all.length < 3) {
        all.push(all[0]); // duplicate first
    }

    const chunks = [];
    for (let i = 0; i < all.length; i += 30) {
        chunks.push(all.slice(i, i + 30));
    }

    const outputs = [];

    chunks.forEach((group, idx) => {
        const zip = new AdmZip();

        group.forEach(f => {
            zip.addLocalFile(path.join(outDir, f));
        });

        zip.addLocalFile(path.join(outDir, 'tray.png'));

        const titleFile = path.join(outDir, 'title.txt');
        const authorFile = path.join(outDir, 'author.txt');

        zip.addLocalFile(titleFile);
        zip.addLocalFile(authorFile);

        const suffix = chunks.length > 1 ? `_${idx + 1}` : '';
        const outFile = path.join(base, `${id}${suffix}.wastickers`);

        zip.writeZip(outFile);

        console.log(`Pack created: ${path.basename(outFile)}`);

        outputs.push(outFile);
    });

    return outputs;
};

/* ========= main ========= */
exports.generate = async id => {
    console.log(`Start process pack ${id}`);

    const base = path.join('data', String(id));
    const animDir = path.join(base, 'animation@2x');
    const outDir = path.join(base, 'output');
    const tmpDir = path.join(base, 'tmp');

    // clean previous generation
    fs.readdirSync(base)
        .filter(f => f.endsWith('.wastickers'))
        .forEach(f => {
            fs.unlinkSync(path.join(base, f));
        });
    if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true, force: true });
    }

    mkdir(outDir);
    mkdir(tmpDir);

    const { title, author } = meta_resolve(base, id);
    const isAnimated = fs.existsSync(animDir);

    if (isAnimated) {
        const files = fs.readdirSync(animDir).filter(f => f.endsWith('.png'));

        for (const f of files) {
            const tmp = path.join(tmpDir, f.replace('.png', ''));
            mkdir(tmp);

            const delays = animated_extractFrames(path.join(animDir, f), tmp);

            const out = path.join(outDir, f.replace('.png', '.webp'));

            animated_encode(tmp, out, delays);

            console.log(`Processed ${path.basename(out)}`);
            fs.rmSync(tmp, { recursive: true, force: true });
        }

    } else {
        const files = fs.readdirSync(base)
            .filter(f =>
                /^\d+@2x\.png$/.test(f)
            );

        for (const f of files) {
            const input = path.join(base, f);
            const out = path.join(outDir, f.replace('@2x.png', '.webp'));

            static_processImage(input, out);

            console.log(`Processed ${path.basename(out)}`);
        }
    }

    fs.writeFileSync(path.join(outDir, 'title.txt'), title);
    fs.writeFileSync(path.join(outDir, 'author.txt'), author);

    tray_process(
        path.join(base, 'tab_on@2x.png'),
        path.join(outDir, 'tray.png')
    );

    const outputs = packageStickers(base, outDir, id, title, author);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(`Pack ${id} completed`);

    return outputs.map(f => ({
        name: path.basename(f),
        id: Buffer.from(f).toString('base64')
    }));

};