const { chromium } = require('playwright');
const https = require('https');
const { anonymizeProxy, closeAnonymizedProxy } = require('proxy-chain');

const EMAIL = process.env.ACL_EMAIL;
const PASSWORD = process.env.ACL_PASSWORD;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PROXY_URL = process.env.PROXY_URL;
const BASE_URL = 'https://dash.aclclouds.com';

async function notify(message, photoPath) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  if (photoPath) {
    const fs = require('fs');
    const boundary = '----FB' + Math.random().toString(36).slice(2);
    const fileData = fs.readFileSync(photoPath);
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT_ID}\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${message}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="err.png"\r\nContent-Type: image/png\r\n\r\n` + fileData.toString('binary') + `\r\n--${boundary}--\r\n`;
    return new Promise((resolve, reject) => {
      const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{console.log('[TG] Photo sent');resolve(d);}); });
      req.on('error', reject); req.write(body, 'binary'); req.end();
    });
  }
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{console.log('[TG] Notification sent');resolve(d);}); });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  console.log('=== ACLClouds Auto-Renew ===');
  console.log(`Time: ${new Date().toISOString()}`);

  let localProxyUrl = null;
  if (PROXY_URL) {
    console.log('[0] Starting proxy tunnel...');
    localProxyUrl = await anonymizeProxy(PROXY_URL);
    console.log(`  Proxy: ${localProxyUrl}`);
  }

  const launchOptions = { headless: true };
  if (localProxyUrl) launchOptions.proxy = { server: localProxyUrl };

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // Capture network responses for debugging
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/auth/login') && response.request().method() === 'POST') {
      try {
        const body = await response.json();
        console.log(`  [API] POST /auth/login => ${response.status()}: ${JSON.stringify(body)}`);
      } catch (e) {
        console.log(`  [API] POST /auth/login => ${response.status()} (non-JSON)`);
      }
    }
  });

  try {
    console.log('[1] Loading login page...');
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'networkidle' });

    console.log('[2] Filling credentials...');
    await page.fill('#username', EMAIL);
    await page.fill('#password', PASSWORD);

    console.log('[3] Solving captcha...');
    const captcha = page.locator('.auth-captcha-inner').first();
    const box = await captcha.boundingBox();
    if (box) {
      await page.mouse.move(box.x - 50, box.y - 30);
      await page.waitForTimeout(300);
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.waitForTimeout(200);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(150);
    }
    await captcha.click();
    await page.waitForTimeout(3000);

    const verified = await page.locator('.auth-captcha-box.verified').count();
    if (verified === 0) {
      console.log('[3b] Retrying captcha...');
      await captcha.click();
      await page.waitForTimeout(3000);
    }
    console.log(`  Captcha verified: ${(await page.locator('.auth-captcha-box.verified').count()) > 0}`);

    console.log('[4] Signing in...');
    // Click and wait for network response
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/auth/login') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
      page.click('button:has-text("Sign in")')
    ]);

    if (response) {
      console.log(`  Login response: ${response.status()}`);
      try {
        const body = await response.json();
        console.log(`  Login body: ${JSON.stringify(body)}`);
      } catch (e) {}
    } else {
      console.log('  No POST /auth/login response captured');
    }

    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    console.log(`  Current URL: ${currentUrl}`);

    if (currentUrl.includes('/auth/login')) {
      const screenshotPath = '/tmp/acl_login_error.png';
      await page.screenshot({ path: screenshotPath, fullPage: true });
      
      // Get all visible text for debugging
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log(`  Page text: ${bodyText.substring(0, 500)}`);
      
      await notify(`❌ ACLClouds Login Failed\nURL: ${currentUrl}\nProxy: ${PROXY_URL ? 'Yes' : 'No'}\n\nPage text:\n${bodyText.substring(0, 300)}`, screenshotPath);
      throw new Error('Login failed - still on login page');
    }

    await page.waitForTimeout(2000);
    console.log('[OK] Logged in!');

    console.log('[5] Fetching servers...');
    const serversResp = await page.evaluate(async () => {
      const r = await fetch('/api/client');
      return r.json();
    });

    if (serversResp.errors) {
      await notify(`❌ ACLClouds API Error: ${JSON.stringify(serversResp.errors)}`);
      process.exit(1);
    }

    const servers = serversResp.data;
    console.log(`[5] Found ${servers.length} server(s)`);

    let results = [];
    for (const server of servers) {
      const { uuid, name, can_renew, expires_at } = server.attributes;
      console.log(`\n--- ${name} (${uuid}) ---`);
      console.log(`  Expires: ${expires_at} | Can renew: ${can_renew}`);

      if (can_renew) {
        console.log('  [RENEWING]...');
        const renewResp = await page.evaluate(async (uuid) => {
          const csrfMeta = document.querySelector('meta[name="csrf-token"]');
          const csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';
          const r = await fetch(`/api/client/servers/${uuid}/upgrade/renew`, {
            method: 'POST', headers: { 
              'Content-Type': 'application/json',
              'X-CSRF-TOKEN': csrfToken,
              'X-Requested-With': 'XMLHttpRequest'
            }
          });
          return r.json();
        }, uuid);
        console.log('  Response:', JSON.stringify(renewResp));
        if (renewResp.error) results.push(`⚠️ ${name}: ${renewResp.error}`);
        else if (renewResp.requires_payment) results.push(`💰 ${name}: Requires payment`);
        else results.push(`✅ ${name}: Renewed!`);
      } else {
        console.log('  ⏳ Not available yet');
        results.push(`⏳ ${name}: Not available yet (expires: ${expires_at})`);
      }
    }

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    await notify(`☁️ <b>ACLClouds Auto-Renew</b>\n⏰ ${now}\n\n${results.join('\n')}`);
    console.log('\n=== Summary ===');
    results.forEach(r => console.log(r));
    console.log('\n=== Done ===');

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
    if (localProxyUrl) await closeAnonymizedProxy(localProxyUrl);
  }
})();
