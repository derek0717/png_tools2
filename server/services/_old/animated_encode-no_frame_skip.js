const animated_encode = (dir, out, delays) => {
    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.png'))
        .sort();

    if (!files.length) throw new Error('No frames');

    // Build frame args with per-frame delays (in ms)
    const buildArgs = () => {
        let args = '';
        for (let i = 0; i < files.length; i++) {
            const f = path.join(dir, files[i]);
            const d = Math.max(1, delays[i] || 100);
            args += ` -frame "${f}" +${d}`;
        }
        return args;
    };

    const frameArgs = buildArgs();

    for (const q of [90,85,80,75,70,65,60,55,50]) {

        const cmd = `img2webp -quiet -loop 0 -q ${q}${frameArgs} -o "${out}"`;

        try {
            run(cmd);

            if (fs.existsSync(out)) {
                const size = fs.statSync(out).size;

                if (size <= MAX) {
                    return out;
                }
            }

        } catch {
            // ignore and try lower quality
        }
    }

    throw new Error('Failed to compress under 500KB');
};