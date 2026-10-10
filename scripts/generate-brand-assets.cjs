/**
 * Regenerates the web brand assets from logo.jpeg (repository root).
 * Usage: npm run brand:assets
 *
 * Outputs:
 *   apps/web/public/brand/sma-mark.png   512×512 figure on white (sidebar, headers)
 *   apps/web/public/brand/sma-logo.webp  full "SMA Technology" logo (sign-in page)
 *   apps/web/src/app/icon.png            512×512 favicon / app icon (Next.js convention)
 *   apps/web/src/app/apple-icon.png      180×180 Apple touch icon
 */
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'logo.jpeg');
const out = (file) => path.join(root, 'apps', 'web', file);

async function main() {
  // Blank out the "SMA Technology" wordmark so only the figure remains in the square mark.
  const textMask = await sharp({
    create: { width: 900, height: 360, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const figureOnly = await sharp(src)
    .composite([{ input: textMask, left: 712, top: 305 }])
    .toBuffer();
  const figure = await sharp(figureOnly)
    .extract({ left: 30, top: 80, width: 820, height: 820 })
    .toBuffer();
  const square = (size, pad) =>
    sharp(figure)
      .resize(size - pad * 2, size - pad * 2, { fit: 'contain', background: '#ffffff' })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
      .flatten({ background: '#ffffff' });

  await square(512, 24).png().toFile(out('public/brand/sma-mark.png'));
  await square(512, 40).png().toFile(out('src/app/icon.png'));
  await square(180, 14).png().toFile(out('src/app/apple-icon.png'));
  // PWA install icons; the maskable one keeps the figure inside the 80% safe zone.
  await square(192, 12).png().toFile(out('public/brand/icon-192.png'));
  await square(512, 72).png().toFile(out('public/brand/icon-512-maskable.png'));
  await sharp(src)
    .resize({ width: 960 })
    .webp({ quality: 90 })
    .toFile(out('public/brand/sma-logo.webp'));
  console.log('Brand assets written to apps/web/public/brand and apps/web/src/app');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
