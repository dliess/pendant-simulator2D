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
    window.__resizeObservers=new Set();const NativeResizeObserver=window.ResizeObserver;
    window.ResizeObserver=class extends NativeResizeObserver {
      constructor(...args){super(...args);__resizeObservers.add(this);}
      disconnect(){super.disconnect();__resizeObservers.delete(this);}
    };
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
  // Housing transparency is independent of panel transparency and keeps the
  // display opaque. Check actual canvas alpha, including restoration.
  await evaluate('a.dataset.showHousing="false";__advance(1)');
  assert.deepEqual(await evaluate('Array.from(appearanceCanvas.getContext("2d").getImageData(200,35,1,1).data)'), [0, 0, 0, 0]);
  assert.deepEqual(await evaluate('Array.from(appearanceCanvas.getContext("2d").getImageData(200,200,1,1).data)'), [2, 7, 11, 255]);
  assert.deepEqual(await evaluate('Array.from(appearanceCanvas.getContext("2d").getImageData(0,0,1,1).data)'), [8, 12, 18, 255]);
  assert.deepEqual(await evaluate('Array.from(b.querySelector("canvas").getContext("2d").getImageData(200,35,1,1).data)'), [89, 101, 116, 255]);
  await evaluate('a.dataset.transparentBackground="true";__advance(1)');
  assert.equal(await evaluate('appearanceCanvas.getContext("2d").getImageData(200,35,1,1).data[3]'), 0);
  assert.equal(await evaluate('appearanceCanvas.getContext("2d").getImageData(0,0,1,1).data[3]'), 0);
  await evaluate('a.dataset.showHousing="true";a.dataset.transparentBackground="false";a.dataset.ledColor="green";__advance(1)');
  assert.deepEqual(await evaluate('Array.from(appearanceCanvas.getContext("2d").getImageData(200,35,1,1).data)'), [89, 101, 116, 255]);
  await evaluate(`window.ledPixels=canvas=>{const data=canvas.getContext('2d').getImageData(0,0,400,400).data;
    let blue=0,green=0;for(let i=0;i<data.length;i+=4){if(data[i+3]<200)continue;
    if(data[i+2]>data[i+1]+30&&data[i+1]>data[i]+30)blue++;
    if(data[i+1]>data[i+2]+30&&data[i+1]>data[i]+30)green++;}return {blue,green}}`);
  assert.ok(await evaluate('ledPixels(appearanceCanvas).green > 100 && ledPixels(appearanceCanvas).blue === 0'));
  assert.ok(await evaluate('ledPixels(b.querySelector("canvas")).blue > 100 && ledPixels(b.querySelector("canvas")).green === 0'));
  await evaluate('a.dataset.ledColor="invalid";__advance(1)');
  assert.ok(await evaluate('ledPixels(appearanceCanvas).blue > 100 && ledPixels(appearanceCanvas).green === 0'));
  // Color and housing changes do not reset the liquid: restoring the default
  // appearance produces the same image as the untouched instance.
  assert.equal(await evaluate('appearanceCanvas.toDataURL() === b.querySelector("canvas").toDataURL()'), true);
  // Sample LED centers, avoiding antialiased edges. Every core must be
  // either the unchanged display background or the full selected opaque color.
  await evaluate(`window.ledStates=(canvas,color)=>{
    const context=canvas.getContext('2d'),lit=color==='green'?[0,255,110,255]:[0,190,255,255];
    let on=0,off=0,shape=null;const invalid=[];
    for(let y=0;y<16;y++)for(let x=0;x<16;x++){
      const dx=x-7.5,dy=y-7.5;if(Math.hypot(dx,dy)>7.6)continue;
      const pixel=Array.from(context.getImageData(Math.round(200+dx*19),Math.round(200+dy*19),1,1).data);
      if(pixel.every((value,k)=>value===lit[k])){
        on++;
        if(!shape){const at=(ox,oy)=>Array.from(context.getImageData(Math.floor(200+dx*19+ox),Math.floor(200+dy*19+oy),1,1).data);
          shape={vertical:at(0,5),horizontal:at(5,0),corner:at(4,5),inside:at(3,4)};}
      }
      else if(pixel.every((value,k)=>value===[2,7,11,255][k]))off++;
      else invalid.push(pixel);
    }return {on,off,invalid,shape};}`);
  for (const color of ['blue','green','blue']) {
    await evaluate(`a.dataset.ledColor=${JSON.stringify(color)};__advance(6)`);
    const states=await evaluate(`ledStates(appearanceCanvas,${JSON.stringify(color)})`);
    assert.deepEqual(states.invalid, [], 'LED cores must never have intermediate brightness');
    assert.ok(states.on > 0 && states.off > 0, JSON.stringify(states));
    const full=color==='green'?[0,255,110,255]:[0,190,255,255];
    assert.deepEqual(states.shape.vertical,full,'rounded LEDs extend further vertically');
    assert.notDeepEqual(states.shape.horizontal,full,'rounded LEDs are narrower than they are tall');
    assert.deepEqual(states.shape.inside,full,'the rectangular interior stays fully lit');
    assert.notDeepEqual(states.shape.corner,full,'the outer corners are rounded');
  }
  assert.equal(await evaluate('appearanceCanvas.toDataURL() === b.querySelector("canvas").toDataURL()'), true);
  await command('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  for (const [scale, width] of [['50',200],['100',400],['150',600],['10',200],['200',600],['invalid',400]]) {
    await evaluate(`a.dataset.radiusScale=${JSON.stringify(scale)}`);
    assert.equal(await evaluate('appearanceCanvas.getBoundingClientRect().width'), width);
    assert.equal(await evaluate('b.querySelector("canvas").getBoundingClientRect().width'), 400);
    assert.equal(await evaluate('a.querySelector("canvas")===appearanceCanvas'), true);
  }
  // Container sizing uses CSS so a parent layout change alone resizes the
  // pendant. It ignores the fixed radius and preserves the simulation instance.
  await evaluate(`window.sizeImage=appearanceCanvas.toDataURL();window.sizeCleanup=PendantSimulator.mountSimulator(a);
    a.dataset.sizeMode='container';a.dataset.radiusScale='150'`);
  assert.equal(await evaluate('appearanceCanvas.getBoundingClientRect().width'), 644);
  for (const [padding, width] of [['0',700],['5',630],['40',140],['-1',700],['101',140],['invalid',644]]) {
    await evaluate(`a.dataset.containerPadding=${JSON.stringify(padding)}`);
    assert.equal(await evaluate('appearanceCanvas.getBoundingClientRect().width'), width);
    assert.equal(await evaluate('appearanceCanvas.getBoundingClientRect().height'), width);
    assert.equal(await evaluate('b.querySelector("canvas").getBoundingClientRect().width'), 400);
  }
  await evaluate(`a.dataset.containerPadding='5';
    window.offsetTop=appearanceCanvas.getBoundingClientRect().top;
    window.offsetHeadingTop=a.querySelector('h2').getBoundingClientRect().top;
    window.offsetHintTop=a.querySelector('.pendant-simulator__hint').getBoundingClientRect().top;
    window.offsetBlockHeight=appearanceRoot.getBoundingClientRect().height`);
  for (const [offset, percent] of [['-10',-10],['0',0],['10',10],['-100',-10],['100',10],['invalid',0]]) {
    await evaluate(`a.dataset.verticalOffset=${JSON.stringify(offset)}`);
    assert.ok(await evaluate(`Math.abs(appearanceCanvas.getBoundingClientRect().top-offsetTop-offsetBlockHeight*${percent}/100)<0.05`));
    assert.equal(await evaluate('a.querySelector("h2").getBoundingClientRect().top'), await evaluate('offsetHeadingTop'));
    assert.equal(await evaluate('a.querySelector(".pendant-simulator__hint").getBoundingClientRect().top'), await evaluate('offsetHintTop'));
    assert.equal(await evaluate('appearanceRoot.getBoundingClientRect().height'), await evaluate('offsetBlockHeight'));
    assert.equal(await evaluate('new DOMMatrix(getComputedStyle(b.querySelector("canvas")).transform).m42'), 0);
  }
  await evaluate(`a.dataset.verticalOffset='10';a.style.width='360px'`);
  assert.ok(Math.abs(await evaluate('appearanceCanvas.getBoundingClientRect().width') - 324) < 0.05);
  assert.ok(Math.abs(await evaluate('appearanceCanvas.getBoundingClientRect().height') - 324) < 0.05);
  await waitFor(`Math.abs(new DOMMatrix(getComputedStyle(appearanceCanvas).transform).m42-appearanceRoot.getBoundingClientRect().height*0.1)<0.05`);
  assert.notEqual(await evaluate('appearanceRoot.getBoundingClientRect().height'), await evaluate('offsetBlockHeight'));
  await evaluate(`a.style.width='';a.dataset.radiusScale='50'`);
  assert.equal(await evaluate('appearanceCanvas.getBoundingClientRect().width'), 630);
  await waitFor(`Math.abs(new DOMMatrix(getComputedStyle(appearanceCanvas).transform).m42-appearanceRoot.getBoundingClientRect().height*0.1)<0.05`);
  await evaluate(`a.dataset.sizeMode='fixed'`);
  assert.equal(await evaluate('appearanceCanvas.getBoundingClientRect().width'), 200);
  assert.equal(await evaluate('getComputedStyle(appearanceRoot).padding'), '16px');
  await evaluate(`a.dataset.sizeMode='invalid'`);
  assert.equal(await evaluate('appearanceCanvas.getBoundingClientRect().width'), 200);
  assert.equal(await evaluate('a.querySelector("canvas")===appearanceCanvas && appearanceCanvas.toDataURL()===sizeImage && PendantSimulator.mountSimulator(a)===sizeCleanup'), true);
  await evaluate(`a.dataset.sizeMode='fixed'`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  // Exercise the original stirring gesture at half radius as well.
  await evaluate('a.dataset.ledColor="blue";a.dataset.radiusScale="50";a.dataset.verticalOffset="5"');
  const rect = await evaluate('a.querySelector("canvas").getBoundingClientRect().toJSON()');
  const y = rect.y + rect.height * 0.75;
  for (const [type, x, buttons] of [['mousePressed', rect.x + rect.width * 0.3, 1],
    ['mouseMoved', rect.x + rect.width * 0.7, 1], ['mouseReleased', rect.x + rect.width * 0.7, 0]]) {
    await command('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  }
  await evaluate('__advance(30)');
  assert.equal(await evaluate('a.querySelector("canvas").toDataURL() !== b.querySelector("canvas").toDataURL()'), true);
  assert.deepEqual(await evaluate('ledStates(appearanceCanvas,"blue").invalid'), []);
  await evaluate('a.querySelector("button").click()');
  await waitFor('a.querySelector("button").getAttribute("aria-pressed") === "true"');
  assert.equal(await evaluate('b.querySelector("button").getAttribute("aria-pressed")'), 'false');
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length'), 2);
  await evaluate('a.dataset.backgroundColor="#f6f0e5";a.dataset.transparentBackground="true";a.dataset.showHousing="false";a.dataset.ledColor="green";a.dataset.radiusScale="150";a.dataset.sizeMode="container";a.dataset.containerPadding="24"');
  assert.equal(await evaluate('a.querySelector("button").getAttribute("aria-pressed")'), 'true');
  assert.equal(await evaluate('a.querySelector("canvas")===appearanceCanvas'), true);
  await evaluate('a.dataset.sizeMode="fixed";a.dataset.verticalOffset="0"');
  // Blank headings are absent from the DOM and leave no heading gap. Hiding
  // phone controls collapses the whole group without resetting enabled sensors.
  await evaluate(`window.presentationImage=appearanceCanvas.toDataURL();window.presentationCleanup=PendantSimulator.mountSimulator(a);
    a.dataset.heading='';a.dataset.showMotionControls='false'`);
  assert.equal(await evaluate('a.querySelector("h2")'), null);
  assert.equal(await evaluate('appearanceRoot.firstElementChild===appearanceCanvas'), true);
  assert.equal(await evaluate('appearanceCanvas.getBoundingClientRect().top-appearanceRoot.getBoundingClientRect().top'), 16);
  assert.equal(await evaluate('a.querySelector(".pendant-simulator__motion-controls").getClientRects().length'), 0);
  assert.ok(await evaluate('a.querySelector(".pendant-simulator__hint").getClientRects().length > 0'));
  assert.equal(await evaluate('b.querySelector(".pendant-simulator__motion-controls").hidden'), false);
  assert.equal(await evaluate('b.querySelector("h2").textContent'), 'Two');
  await evaluate(`a.dataset.heading=${JSON.stringify(' \n\t ')};a.dataset.backgroundColor='#f6f0e5'`);
  assert.equal(await evaluate('a.querySelector("h2")'), null);
  await evaluate(`a.dataset.showHeading='false';a.dataset.heading='Try the pendant'`);
  assert.equal(await evaluate('a.querySelector("h2")'), null);
  await evaluate(`a.dataset.showHeading='true';a.dataset.showMotionControls='true'`);
  assert.equal(await evaluate('appearanceRoot.firstElementChild.textContent'), 'Try the pendant');
  assert.ok(await evaluate('a.querySelector(".pendant-simulator__motion-controls").getClientRects().length > 0'));
  assert.equal(await evaluate('a.querySelector("canvas")===appearanceCanvas && appearanceCanvas.toDataURL()===presentationImage && PendantSimulator.mountSimulator(a)===presentationCleanup'), true);
  assert.equal(await evaluate('a.querySelector("button").getAttribute("aria-pressed")'), 'true');
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length'), 2);
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
  await evaluate('a.dataset.sizeMode="container";a.dataset.containerPadding="20"');
  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  assert.ok(await evaluate('a.querySelector("canvas").getBoundingClientRect().width <= 320'));
  assert.equal(await evaluate('a.querySelector("canvas").getBoundingClientRect().width'), 192);
  assert.equal(await evaluate('a.querySelector("canvas").getBoundingClientRect().height'), 192);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= 320'));
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/pendant-shopify-smoke.png', Buffer.from(screenshot.data, 'base64'));
  await evaluate('document.querySelector("#section").remove();document.querySelector("#below").remove()');
  assert.equal(await evaluate('__frames.size'), 0);
  assert.equal(await evaluate('__resizeObservers.size'), 0);
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
  await evaluate(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(blockMarkup('data-particle-count="500" data-heading="" data-show-motion-controls="false" data-size-mode="container" data-container-padding="10"'))})`);
  await waitFor('document.querySelectorAll(".pendant-simulator").length === 1');
  assert.equal(await evaluate('document.querySelector(".pendant-simulator__heading")'), null);
  assert.equal(await evaluate('document.querySelector(".pendant-simulator").firstElementChild.tagName'), 'CANVAS');
  assert.equal(await evaluate('document.querySelector(".pendant-simulator__motion-controls").getClientRects().length'), 0);
  assert.equal(await evaluate('document.querySelector("canvas").getBoundingClientRect().width'), 256);
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length'), 0);
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
  console.log('Browser checks passed: tall rounded rectangular LEDs with fully on/off blue and green cores; percentage padding; vertical offset follows enclosing block height through resizes without moving labels or changing layout; offset stirring and observer cleanup; container sizing preserves fixed settings; hidden controls and headings collapse; live updates preserve fluid and sensors; housing and LED colors; radius scaling; scroll inertia; single asset loading; editor reloads; CSP; mobile layout; standalone and Vite development.');
} finally {
  await devServer?.close();
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await once(browser, 'exit');
  }
  server.close();
  // Chrome's helper processes can finish profile writes just after it exits.
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
