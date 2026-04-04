const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 2500, height: 843, deviceScaleFactor: 1 });
  const filePath = path.resolve(__dirname, 'pattern_d.html');
  await page.goto(`file://${filePath}`, { waitUntil: 'load' });
  const outputPath = path.resolve(__dirname, '..', 'pattern_d_2500x843.png');
  await page.screenshot({ path: outputPath, type: 'png' });
  console.log(`Saved: ${outputPath}`);
  await page.close();
  await browser.close();
})();
