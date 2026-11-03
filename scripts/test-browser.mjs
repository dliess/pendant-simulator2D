// Real-browser integration checks using Chrome's DevTools protocol, without an
// npm browser driver. Run after both builds; CHROME_PATH can override detection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const chrome = process.env.CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);
assert.ok(chrome, 'Install Chrome or set CHROME_PATH to run browser checks');
const temporary = await mkdtemp(join(tmpdir(), 'pendant-browser-'));
const liquid = await readFile('blocks/pendant-simulator.liquid', 'utf8');
const blockLoader = `(function(){${liquid.match(/{% javascript %}([\s\S]*?){% endjavascript %}/)[1]}\n})();`;
const assetTemplate = liquid.match(/<template data-pendant-simulator-assets>[\s\S]*?<\/template>/)[0]
  .replaceAll("{{ 'pendant-simulator.css' | asset_url }}", '/shopify/pendant-simulator.css')
  .replaceAll("{{ 'pendant-simulator.js' | asset_url }}", '/shopify/pendant-simulator.js');
const blockMarkup = attributes => `<pendant-simulator ${attributes}>${assetTemplate}</pendant-simulator>`;
const assetRequests = { script: 0, style: 0 };
const fixture = `<!doctype html><html><head>
<link rel="stylesheet" href="/fixture.css">
<script src="/block-loader.js" defer></script>
</head><body><h2 id="theme-heading">Theme heading</h2><div class="pair" id="section">
${blockMarkup('data-heading="One" data-particle-count="500"')}
${blockMarkup('data-heading="Two" data-particle-count="500"')}
</div><div class="spacer"></div>
${blockMarkup('id="below" data-particle-count="500"')}
</body></html>`;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://test').pathname;
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'");
  response.setHeader('Cache-Control', 'no-store');
  if (path === '/block-loader.js') {
    // Shopify extracts {% javascript %} into its external block-scripts.js.
    response.setHeader('Content-Type', 'text/javascript'); response.end(blockLoader); return;
  }
  if (path === '/empty-fixture') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><script src="/block-loader.js" defer></script></head><body></body></html>');
    return;
  }
  if (path === '/scroll-fixture') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><script src="/block-loader.js" defer></script></head><body class="scroll-test">
      <div id="scroll-area">${blockMarkup('id="moving" data-particle-count="500"')}<div class="spacer"></div></div>
      ${blockMarkup('id="fixed" data-particle-count="500"')}
      </body></html>`);
    return;
  }
  if (path === '/fixture') {
    response.setHeader('Content-Type', 'text/html'); response.end(fixture); return;
  }
  if (path === '/fixture.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end('body{margin:0}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.spacer{height:3000px}#theme-heading{font-size:37px;color:rgb(1,2,3)}.scroll-test{height:3000px}.scroll-test #scroll-area{width:450px;height:750px;overflow:auto;margin-top:200px}.scroll-test #fixed{position:fixed;top:200px;right:0;width:450px}@media(max-width:600px){.pair{grid-template-columns:1fr}}');
    return;
  }
  const file = path.startsWith('/shopify/') ? `dist${path}` :
    path.startsWith('/assets/') ? `dist/standalone${path}` :
    path === '/standalone' ? 'dist/standalone/index.html' : null;
  if (!file) { response.writeHead(404); response.end(); return; }
  if (path === '/shopify/pendant-simulator.js') assetRequests.script++;
  if (path === '/shopify/pendant-simulator.css') assetRequests.style++;
  try {
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(resolve(file)));
  } catch { response.writeHead(404); response.end(); }
});
let browser;
let socket;
let devServer;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${temporary}`, 'about:blank'],
  { stdio: 'ignore' });
  let debugPort;
  for (let i = 0; i < 150; i++) {
    try { debugPort = Number((await readFile(join(temporary, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await delay(100); }
  }
  assert.ok(debugPort, 'Chrome did not start its debugging endpoint');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (!message.id) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
    else handler.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__frames = new Map(); let nextFrame = 0; window.__now = 1000;
    performance.now = () => window.__now;
    window.requestAnimationFrame = callback => { const id = ++nextFrame; __frames.set(id, callback); return id; };
    window.cancelAnimationFrame = id => __frames.delete(id);
    window.__advance = count => { for (let i=0;i<count;i++) { __now += 1000/120; const batch=[...__frames.values()]; __frames.clear(); batch.forEach(callback=>callback(__now)); } };
    window.__hidden = false; Object.defineProperty(document, 'hidden', { get: () => __hidden });
    window.__listeners = []; const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) { __listeners.push({target:this,type,listener}); return add.call(this,type,listener,options); };
    EventTarget.prototype.removeEventListener = function(type, listener, options) { __listeners=__listeners.filter(record=>!(record.target===this&&record.type===type&&record.listener===listener)); return remove.call(this,type,listener,options); };
    window.__csp = []; document.addEventListener('securitypolicyviolation', event=>__csp.push(event.violatedDirective));
    window.__loaderObservers=0;const NativeMutationObserver=window.MutationObserver;
    window.MutationObserver=class extends NativeMutationObserver {constructor(...args){super(...args);__loaderObservers++;}};
    window.DeviceMotionEvent = class extends Event { static requestPermission() { return Promise.resolve('granted'); } };
    window.DeviceOrientationEvent = class extends Event { static requestPermission() { return Promise.resolve('granted'); } };
  ` });
  await command('Page.navigate', { url: `${origin}/fixture` });
  await waitFor('!!window.PendantSimulator && document.querySelectorAll(".pendant-simulator").length === 3 && __frames.size === 2');
  assert.deepEqual(assetRequests, { script: 1, style: 1 });
  assert.equal(await evaluate('document.head.querySelectorAll("[data-pendant-simulator-asset]").length'), 2);
  assert.equal(await evaluate('__loaderObservers'), 1);
  assert.equal(await evaluate('document.querySelectorAll(".pendant-simulator [id]").length'), 0);
  assert.deepEqual(await evaluate('({size:getComputedStyle(document.querySelector("#theme-heading")).fontSize,color:getComputedStyle(document.querySelector("#theme-heading")).color})'),
    { size: '37px', color: 'rgb(1, 2, 3)' });
  await evaluate('window.a=document.querySelector("#section").children[0];window.b=document.querySelector("#section").children[1]; __advance(20)');
  assert.equal(await evaluate('a.querySelector("canvas").toDataURL() === b.querySelector("canvas").toDataURL()'), true);
  assert.deepEqual(await evaluate('({background:getComputedStyle(a.querySelector(".pendant-simulator")).backgroundColor,text:getComputedStyle(a.querySelector(".pendant-simulator")).color})'),
    { background: 'rgb(16, 24, 32)', text: 'rgb(255, 255, 255)' });
  await evaluate('window.appearanceRoot=a.querySelector(".pendant-simulator");window.appearanceCanvas=a.querySelector("canvas");window.appearanceImage=appearanceCanvas.toDataURL();a.dataset.backgroundColor="#f6f0e5";a.dataset.textColor="#12233b"');
  assert.deepEqual(await evaluate('({background:getComputedStyle(appearanceRoot).backgroundColor,text:getComputedStyle(appearanceRoot).color,status:getComputedStyle(a.querySelector("[role=status]")).color})'),
    { background: 'rgb(246, 240, 229)', text: 'rgb(18, 35, 59)', status: 'rgb(18, 35, 59)' });
  assert.equal(await evaluate('getComputedStyle(b.querySelector(".pendant-simulator")).backgroundColor'), 'rgb(16, 24, 32)');
  assert.equal(await evaluate('a.querySelector("canvas")===appearanceCanvas && a.querySelector(".pendant-simulator")===appearanceRoot && appearanceCanvas.toDataURL()===appearanceImage'), true);
  assert.equal(await evaluate('__frames.size'), 2);
  await evaluate('a.dataset.backgroundColor="not-a-color";a.dataset.textColor="url(https://invalid.example/color)"');
  assert.deepEqual(await evaluate('({background:getComputedStyle(appearanceRoot).backgroundColor,text:getComputedStyle(appearanceRoot).color})'),
    { background: 'rgb(16, 24, 32)', text: 'rgb(255, 255, 255)' });
  await evaluate('a.dataset.backgroundColor="rgba(246, 240, 229, 0.5)";a.dataset.textColor="#12233b"');
  assert.equal(await evaluate('getComputedStyle(appearanceRoot).backgroundColor'), 'rgba(246, 240, 229, 0.5)');
  await evaluate('a.dataset.transparentBackground="true";__advance(1)');
  assert.equal(await evaluate('getComputedStyle(appearanceRoot).backgroundColor'), 'rgba(0, 0, 0, 0)');
  assert.deepEqual(await evaluate('Array.from(appearanceCanvas.getContext("2d").getImageData(0,0,1,1).data)'), [0, 0, 0, 0]);
  assert.deepEqual(await evaluate('Array.from(appearanceCanvas.getContext("2d").getImageData(200,35,1,1).data)'), [89, 101, 116, 255]);
  assert.equal(await evaluate('b.querySelector("canvas").getContext("2d").getImageData(0,0,1,1).data[3]'), 255);
  assert.equal(await evaluate('a.querySelector("canvas")===appearanceCanvas'), true);
  await evaluate('a.dataset.transparentBackground="false";__advance(1)');
  assert.equal(await evaluate('getComputedStyle(appearanceRoot).backgroundColor'), 'rgba(246, 240, 229, 0.5)');
  assert.deepEqual(await evaluate('Array.from(appearanceCanvas.getContext("2d").getImageData(0,0,1,1).data)'), [8, 12, 18, 255]);
  const rect = await evaluate('a.querySelector("canvas").getBoundingClientRect().toJSON()');
  const y = rect.y + rect.height * 0.75;
  for (const [type, x, buttons] of [['mousePressed', rect.x + rect.width * 0.3, 1],
    ['mouseMoved', rect.x + rect.width * 0.7, 1], ['mouseReleased', rect.x + rect.width * 0.7, 0]]) {
    await command('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  }
  await evaluate('__advance(30)');
  assert.equal(await evaluate('a.querySelector("canvas").toDataURL() !== b.querySelector("canvas").toDataURL()'), true);
  await evaluate('a.querySelector("button").click()');
  await waitFor('a.querySelector("button").getAttribute("aria-pressed") === "true"');
  assert.equal(await evaluate('b.querySelector("button").getAttribute("aria-pressed")'), 'false');
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length'), 2);
  await evaluate('a.dataset.backgroundColor="#f6f0e5";a.dataset.transparentBackground="true"');
  assert.equal(await evaluate('a.querySelector("button").getAttribute("aria-pressed")'), 'true');
  assert.equal(await evaluate('a.querySelector("canvas")===appearanceCanvas'), true);
  await evaluate('window.oldCanvas=a.querySelector("canvas");window.dispose=PendantSimulator.mountSimulator(a);dispose();dispose()');
  assert.equal(await evaluate('__frames.size'), 1);
  assert.equal(await evaluate('oldCanvas.width'), 0);
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length'), 0);
  await evaluate('PendantSimulator.mountSimulator(a)');
  await waitFor('__frames.size === 2');
  await evaluate(`new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/block-loader.js?again';script.onload=resolve;script.onerror=reject;document.body.append(script)})`);
  assert.deepEqual(assetRequests, { script: 1, style: 1 });
  assert.equal(await evaluate('__loaderObservers'), 1);
  await evaluate(`new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/shopify/pendant-simulator.js?again';script.onload=resolve;script.onerror=reject;document.body.append(script)})`);
  assert.equal(await evaluate('document.querySelectorAll(".pendant-simulator").length'), 3);
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="shopify:section:load").length'), 1);
  await evaluate('document.querySelector("#section").dispatchEvent(new Event("shopify:section:unload",{bubbles:true}))');
  assert.equal(await evaluate('__frames.size'), 0);
  await evaluate('document.querySelector("#section").dispatchEvent(new Event("shopify:section:load",{bubbles:true}))');
  await waitFor('__frames.size === 2');
  await evaluate('window.otherCanvas=b.querySelector("canvas");a.dataset.heading="<img src=x onerror=alert(1)>";a.dataset.fillLevel="50"');
  await waitFor('__frames.size === 2');
  assert.equal(await evaluate('a.querySelector("h2").textContent'), '<img src=x onerror=alert(1)>');
  assert.equal(await evaluate('a.querySelectorAll("img").length'), 0);
  assert.equal(await evaluate('b.querySelector("canvas") === otherCanvas'), true);
  await evaluate('__hidden=true;document.dispatchEvent(new Event("visibilitychange"))');
  assert.equal(await evaluate('__frames.size'), 0);
  await evaluate('__now+=60000;__hidden=false;document.dispatchEvent(new Event("visibilitychange"))');
  await waitFor('__frames.size === 2');
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}))');
  assert.equal(await evaluate('__frames.size'), 0);
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));__advance(2)');
  assert.equal(await evaluate('__frames.size'), 2);
  await evaluate('window.scrollTo(0,document.body.scrollHeight)');
  await waitFor('__frames.size === 1');
  await evaluate('window.scrollTo(0,0)');
  await waitFor('__frames.size === 2');
  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  assert.ok(await evaluate('a.querySelector("canvas").getBoundingClientRect().width <= 320'));
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/pendant-shopify-smoke.png', Buffer.from(screenshot.data, 'base64'));
  await evaluate('document.querySelector("#section").remove();document.querySelector("#below").remove()');
  assert.equal(await evaluate('__frames.size'), 0);
  assert.equal(await evaluate('__listeners.filter(record=>["visibilitychange","pagehide","pageshow","devicemotion","deviceorientation","scroll","resize"].includes(record.type)).length'), 0);
  // The editor inserts only block markup; templates themselves must not fetch
  // or execute assets. The once-per-file hook watches the new markup.
  await evaluate(`document.body.insertAdjacentHTML('afterbegin',${JSON.stringify(blockMarkup('data-particle-count="500"'))});window.scrollTo(0,0)`);
  await waitFor('document.querySelectorAll(".pendant-simulator").length === 1 && __frames.size === 1');
  assert.deepEqual(assetRequests, { script: 2, style: 1 }); // Includes the deliberate ?again runtime test.
  assert.deepEqual(await evaluate('__csp'), []);
  // Start with no blocks at all, then add the first and repeated instances.
  await command('Page.navigate', { url: `${origin}/empty-fixture` });
  await waitFor('__loaderObservers === 1');
  const beforeInsertion = { ...assetRequests };
  assert.equal(await evaluate('!!window.PendantSimulator'), false);
  await evaluate(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(blockMarkup('data-particle-count="500"'))})`);
  await waitFor('document.querySelectorAll(".pendant-simulator").length === 1');
  await evaluate(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(blockMarkup('data-particle-count="500"').repeat(2))})`);
  await waitFor('document.querySelectorAll(".pendant-simulator").length === 3');
  assert.deepEqual(assetRequests, { script: beforeInsertion.script + 1, style: beforeInsertion.style + 1 });
  assert.equal(await evaluate('document.head.querySelectorAll("[data-pendant-simulator-asset]").length'), 2);
  assert.deepEqual(await evaluate('__csp'), []);
  // Compare an actual moving pendant with a fixed one. Both start with identical
  // fluid, then receive identical phone readings; only one moves while scrolling.
  await command('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/scroll-fixture` });
  await waitFor('document.querySelectorAll(".pendant-simulator").length === 2 && __frames.size === 2');
  await evaluate(`window.moving=document.querySelector('#moving');window.fixed=document.querySelector('#fixed');
    window.sameFluid=()=>moving.querySelector('canvas').toDataURL()===fixed.querySelector('canvas').toDataURL();
    __advance(120)`);
  assert.equal(await evaluate('sameFluid()'), true);
  await evaluate(`moving.querySelector('button').click();fixed.querySelector('button').click()`);
  await waitFor(`moving.querySelector('button').getAttribute('aria-pressed')==='true' && fixed.querySelector('button').getAttribute('aria-pressed')==='true'`);
  await evaluate(`window.tilt=new Event('deviceorientation');tilt.beta=90;tilt.gamma=5;window.dispatchEvent(tilt);__advance(60)`);
  assert.equal(await evaluate('sameFluid()'), true);
  for (let step = 1; step <= 24; step++) {
    await evaluate(`window.scrollTo(0,${step * 8});document.dispatchEvent(new Event('scroll'));__advance(1)`);
  }
  await evaluate('__advance(60)');
  assert.equal(await evaluate('sameFluid()'), false, 'page scroll adds inertia alongside phone input');
  assert.equal(await evaluate(`fixed.querySelector('canvas').getBoundingClientRect().top`),
    await evaluate(`moving.querySelector('canvas').getBoundingClientRect().top + scrollY`));
  // Start fresh and exercise a nested scroll container rather than the page.
  await evaluate(`for(const block of [moving,fixed]){PendantSimulator.mountSimulator(block)();PendantSimulator.mountSimulator(block)}`);
  await waitFor('__frames.size === 2');
  await evaluate('__advance(120)');
  assert.equal(await evaluate('sameFluid()'), true);
  for (let step = 1; step <= 24; step++) {
    await evaluate(`{const area=document.querySelector('#scroll-area');area.scrollTop=${step * 8};area.dispatchEvent(new Event('scroll'));__advance(1)}`);
  }
  await evaluate('__advance(60)');
  assert.equal(await evaluate('sameFluid()'), false, 'nested scroll events reach the instance');
  // Disabled blocks still scroll normally, but their liquid evolves exactly like
  // the stationary control, including when both have phone motion enabled.
  await evaluate(`moving.dataset.reactToScrolling='false';fixed.dataset.reactToScrolling='false';
    window.scrollTo(0,0);document.querySelector('#scroll-area').scrollTop=0;
    for(const block of [moving,fixed]){PendantSimulator.mountSimulator(block)();PendantSimulator.mountSimulator(block)}`);
  await waitFor('__frames.size === 2');
  await evaluate(`__advance(120);moving.querySelector('button').click();fixed.querySelector('button').click()`);
  await waitFor(`moving.querySelector('button').getAttribute('aria-pressed')==='true' && fixed.querySelector('button').getAttribute('aria-pressed')==='true'`);
  await evaluate(`window.dispatchEvent(tilt);__advance(60);
    window.toggleCanvas=moving.querySelector('canvas');window.toggleCleanup=PendantSimulator.mountSimulator(moving)`);
  assert.equal(await evaluate('sameFluid()'), true);
  for (let step = 1; step <= 24; step++) {
    await evaluate(`window.scrollTo(0,${step * 8});document.dispatchEvent(new Event('scroll'));__advance(1)`);
  }
  await evaluate('__advance(60)');
  assert.equal(await evaluate('sameFluid()'), true, 'turning scroll reaction off preserves normal gravity and phone input');
  await evaluate(`window.toggleImage=toggleCanvas.toDataURL();moving.dataset.reactToScrolling='true'`);
  assert.equal(await evaluate(`moving.querySelector('canvas')===toggleCanvas && toggleCanvas.toDataURL()===toggleImage && PendantSimulator.mountSimulator(moving)===toggleCleanup`), true);
  assert.equal(await evaluate(`moving.querySelector('button').getAttribute('aria-pressed')`), 'true');
  assert.equal(await evaluate(`fixed.dataset.reactToScrolling`), 'false');
  await evaluate('__advance(1)');
  for (let step = 1; step <= 24; step++) {
    await evaluate(`{const area=document.querySelector('#scroll-area');area.scrollTop=${step * 8};area.dispatchEvent(new Event('scroll'));__advance(1)}`);
  }
  assert.equal(await evaluate('sameFluid()'), false, 're-enabling scroll motion takes effect on just that block');
  await evaluate(`window.toggleImage=toggleCanvas.toDataURL();moving.dataset.reactToScrolling='false'`);
  assert.equal(await evaluate(`moving.querySelector('canvas')===toggleCanvas && toggleCanvas.toDataURL()===toggleImage && PendantSimulator.mountSimulator(moving)===toggleCleanup`), true);
  assert.equal(await evaluate(`moving.querySelector('button').getAttribute('aria-pressed')`), 'true');
  assert.equal(await evaluate('__frames.size'), 2);
  await evaluate('moving.remove();fixed.remove()');
  assert.equal(await evaluate('__frames.size'), 0);
  assert.equal(await evaluate('__listeners.filter(record=>["scroll","resize","devicemotion","deviceorientation"].includes(record.type)).length'), 0);
  assert.deepEqual(await evaluate('__csp'), []);
  await command('Page.navigate', { url: `${origin}/standalone` });
  await waitFor('document.querySelectorAll("#app .pendant-simulator").length === 1 && __frames.size === 1');
  assert.deepEqual(errors, []);
  assert.deepEqual(await evaluate('__csp'), []);
  // Use the same default Vite config as npm run dev, in addition to testing the
  // production files above. The dev server is always closed by this harness.
  const { createServer: createViteServer } = await import('vite');
  devServer = await createViteServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await devServer.listen();
  await command('Page.navigate', { url: devServer.resolvedUrls.local[0] });
  await waitFor('document.querySelectorAll("#app .pendant-simulator").length === 1 && __frames.size === 1');
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: live per-block scroll toggle preserves fluid and sensors; page/nested scroll inertia alongside sensors; fixed pendant; per-block background/text colors and alpha; live style updates preserve canvas, motion and fluid state; invalid-color fallback; single asset loading; independent stirring/sensors; cleanup; editor reloads; CSP; mobile layout; standalone and Vite development.');
} finally {
  await devServer?.close();
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await once(browser, 'exit');
  }
  server.close();
  await rm(temporary, { recursive: true, force: true });
}
