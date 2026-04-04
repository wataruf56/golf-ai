const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const patterns = ['pattern_a', 'pattern_b', 'pattern_c', 'pattern_d'];

  for (const name of patterns) {
    const page = await browser.newPage();
    await page.setViewport({ width: 2500, height: 843, deviceScaleFactor: 1 });
    const filePath = path.resolve(__dirname, `${name}.html`);
    await page.goto(`file://${filePath}`, { waitUntil: 'load' });
    const outputPath = path.resolve(__dirname, '..', `${name}_2500x843.png`);
    await page.screenshot({ path: outputPath, type: 'png' });
    console.log(`Saved: ${outputPath}`);
    await page.close();
  }

  await browser.close();
})();
