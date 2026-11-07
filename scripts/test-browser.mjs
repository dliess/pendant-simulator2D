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
const blockMarkup = (attributes, photo = '') => `<pendant-simulator ${attributes}>${photo}${assetTemplate}</pendant-simulator>`;
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
  if (path === '/photo.svg' || path === '/landscape.svg') {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${path === '/photo.svg' ? 1400 : 600}">
      <rect width="100%" height="100%" fill="#e7ddd0"/>
      <path d="M220 0L520 665L820 0" fill="none" stroke="#a48754" stroke-width="12"/>
      <circle cx="520" cy="840" r="175" fill="#a48754"/><circle cx="520" cy="840" r="150" fill="#02070b"/>
      </svg>`);
    return;
  }
  if (path === '/photo-fixture') {
    response.setHeader('Content-Type', 'text/html');
    const photo = '<template data-pendant-simulator-photo><img src="/photo.svg" width="1000" height="1400" alt="Pendant necklace" loading="lazy"></template>';
    const attributes = 'data-display-mode="photo" data-photo-center-x="52" data-photo-center-y="60" data-photo-diameter="30" data-heading="" data-particle-count="500" data-react-to-scrolling="false" data-size-mode="container" data-container-padding="25" data-vertical-offset="10" data-radius-scale="150"';
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><script src="/block-loader.js" defer></script></head><body><div class="pair" id="photo-pair">${blockMarkup(attributes, photo)}${blockMarkup(attributes, photo)}</div></body></html>`);
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
  // Record the rendered core paths, including unlit LEDs, to verify the physical
  // rows and the tighter border clearance independently of fluid.
  const layout = await evaluate(`(() => {
    const context=appearanceCanvas.getContext('2d'), original=context.moveTo, paths=[];
    context.moveTo=function(x,y){paths.push({x,y});return original.call(this,x,y)};
    try { __advance(1); } finally { context.moveTo=original; }
    const rows=new Map();
    for(const {y} of paths){const key=Math.round(y*10)/10;rows.set(key,(rows.get(key)||0)+1);}
    return {counts:[...rows.entries()].sort((a,b)=>b[0]-a[0]).map(([,count])=>count),
      top:Math.min(...paths.map(p=>p.y))-42,
      bottom:358-(Math.max(...paths.map(p=>p.y))+14),
      left:Math.min(...paths.map(p=>p.x))-3.5,
      right:Math.max(...paths.map(p=>p.x))+3.5,
      clearance:Math.min(...paths.map(p=>158-Math.hypot(Math.abs(p.x-200)+3.5,Math.abs(p.y+7-200)+7)))};
  })()`);
  assert.deepEqual(layout.counts, [4,8,10,12,12,14,14,14,14,12,12,10,8,4]);
  assert.equal(layout.top, 17.5);
  assert.equal(layout.bottom, 11.5);
  assert.equal(layout.left, 53.5);
  assert.equal(layout.right, 346.5);
  assert.ok(layout.clearance>5, 'even the outer LED corners must stay inside the circle');
  await evaluate(`window.ledStates=(canvas,color)=>{
    const context=canvas.getContext('2d'),lit=color==='green'?[130,255,175,255]:[100,220,255,255];
    let on=0,off=0,shape=null;const invalid=[];
    const rows=[4,8,10,12,12,14,14,14,14,12,12,10,8,4];
    for(let row=rows.length-1;row>=0;row--)for(let x=0;x<rows[row];x++){
      const dx=x-(rows[row]-1)/2,dy=(rows.length-1)/2-row;
      const px=200+dx*22,py=203+dy*21;
      const pixel=Array.from(context.getImageData(Math.round(px),Math.round(py),1,1).data);
      if(pixel.every((value,k)=>value===lit[k])){
        on++;
        if(!shape){const at=(ox,oy)=>Array.from(context.getImageData(Math.floor(px+ox),Math.floor(py+oy),1,1).data);
          shape={vertical:at(0,6),horizontal:at(4,0),corner:at(3,6),inside:at(2,4),
            glowNear:at(0,-9),glowFar:at(0,-11),glowOutside:at(0,-17)};}
      }
      else if(pixel.every((value,k)=>value===[2,7,11,255][k]))off++;
      else invalid.push(pixel);
    }return {on,off,invalid,shape};}`);
  for (const color of ['blue','green','blue']) {
    await evaluate(`a.dataset.ledColor=${JSON.stringify(color)};__advance(6)`);
    const states=await evaluate(`ledStates(appearanceCanvas,${JSON.stringify(color)})`);
    assert.deepEqual(states.invalid, [], 'LED cores must never have intermediate brightness');
    assert.equal(states.on + states.off, 148);
    assert.ok(states.on > 0 && states.off > 0, JSON.stringify(states));
    const full=color==='green'?[130,255,175,255]:[100,220,255,255];
    assert.deepEqual(states.shape.vertical,full,'rounded LEDs extend further vertically');
    assert.notDeepEqual(states.shape.horizontal,full,'rounded LEDs are narrower than they are tall');
    assert.deepEqual(states.shape.inside,full,'the rectangular interior stays fully lit');
    assert.notDeepEqual(states.shape.corner,full,'the outer corners are rounded');
    const channel=color==='green'?1:2;
    assert.ok(states.shape.glowNear[channel]>states.shape.glowFar[channel],JSON.stringify(states.shape));
    assert.ok(states.shape.glowNear[channel]>=100,'the halo is visibly bright near the LED');
    assert.ok(states.shape.glowFar[channel]>=25,`the wider halo remains visible farther from the LED: ${JSON.stringify(states.shape)}`);
    assert.ok(states.shape.glowFar[channel]>states.shape.glowOutside[channel],'the soft halo fades outward');
    assert.deepEqual(states.shape.glowOutside,[2,7,11,255],'neighboring unlit LED cores remain dark');
  }
  assert.equal(await evaluate('appearanceCanvas.toDataURL() === b.querySelector("canvas").toDataURL()'), true);
  await command('Page.captureScreenshot', { format: 'png' }).then(result =>
    writeFile('/tmp/pendant-led-reference-layout.png', Buffer.from(result.data, 'base64')));
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
  // Stir upward through the pool so a splash visibly reaches other LED rows.
  for (const [type, x, y, buttons] of [['mousePressed', 0.3, 0.8, 1],
    ['mouseMoved', 0.5, 0.65, 1], ['mouseMoved', 0.7, 0.5, 1], ['mouseReleased', 0.7, 0.5, 0]]) {
    await command('Input.dispatchMouseEvent', { type, x: rect.x + rect.width * x,
      y: rect.y + rect.height * y, button: 'left', buttons, clickCount: 1 });
  }
  // LEDs are binary samples of the fluid. Look for the splash during the next
  // second rather than requiring a changed occupancy at one arbitrary frame.
  assert.equal(await evaluate(`(() => {
    for(let frame=0;frame<120;frame++){
      __advance(1);
      if(appearanceCanvas.toDataURL()!==b.querySelector('canvas').toDataURL())return true;
    }
    return false;
  })()`), true, 'stirring changes the LED display independently of the other instance');
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
  await evaluate('delete DeviceMotionEvent.requestPermission;delete DeviceOrientationEvent.requestPermission');
  await evaluate(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(blockMarkup('data-particle-count="500" data-heading="" data-show-motion-controls="false" data-size-mode="container" data-container-padding="10"'))})`);
  await waitFor('document.querySelectorAll(".pendant-simulator").length === 1');
  assert.equal(await evaluate('document.querySelector(".pendant-simulator__heading")'), null);
  assert.equal(await evaluate('document.querySelector(".pendant-simulator").firstElementChild.tagName'), 'CANVAS');
  assert.equal(await evaluate('document.querySelector(".pendant-simulator__motion-controls").getClientRects().length'), 0);
  assert.equal(await evaluate('document.querySelector("canvas").getBoundingClientRect().width'), 256);
  await waitFor('document.querySelector("button").getAttribute("aria-pressed")==="true"');
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length'), 2);
  await evaluate(`window.autoBlock=document.querySelector('pendant-simulator');window.autoCanvas=autoBlock.querySelector('canvas');
    window.autoCleanup=PendantSimulator.mountSimulator(autoBlock);autoBlock.dataset.showMotionControls='true';autoBlock.querySelector('button').click()`);
  assert.equal(await evaluate('autoBlock.querySelector("button").getAttribute("aria-pressed")'), 'false');
  await evaluate(`autoBlock.dataset.showMotionControls='false';autoBlock.dataset.textColor='#ffffff'`);
  await waitFor('autoBlock.querySelector("button").getAttribute("aria-pressed")==="true"');
  assert.equal(await evaluate('autoBlock.querySelector("canvas")===autoCanvas && PendantSimulator.mountSimulator(autoBlock)===autoCleanup'), true);
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}))');
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length'), 0);
  await evaluate('window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))');
  await waitFor('autoBlock.querySelector("button").getAttribute("aria-pressed")==="true"');
  await evaluate(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(blockMarkup('data-particle-count="500"').repeat(2))})`);
  await waitFor('document.querySelectorAll(".pendant-simulator").length === 3');
  assert.deepEqual(assetRequests, { script: beforeInsertion.script + 1, style: beforeInsertion.style + 1 });
  assert.equal(await evaluate('document.head.querySelectorAll("[data-pendant-simulator-asset]").length'), 2);
  assert.deepEqual(await evaluate('__csp'), []);
  await evaluate(`for(const block of document.querySelectorAll('pendant-simulator'))block.dataset.showMotionControls='false'`);
  await waitFor('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length===6');
  await evaluate(`document.querySelectorAll('pendant-simulator').forEach(block=>block.remove())`);
  assert.equal(await evaluate('__frames.size'), 0);
  assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation"||record.target instanceof HTMLCanvasElement).length'), 0);
  // Emulate browsers that reject automatic permission requests until a genuine
  // user activation. Tapping and keyboard activation work with the button hidden.
  for (const input of ['pointer','touch','Enter',' ']) {
    await command('Page.navigate', { url: `${origin}/empty-fixture` });
    await waitFor('__loaderObservers === 1');
    await evaluate(`window.__permissionCalls=[];
      DeviceMotionEvent.requestPermission=DeviceOrientationEvent.requestPermission=()=>{
        __permissionCalls.push(navigator.userActivation.isActive);
        return navigator.userActivation.isActive?Promise.resolve('granted'):
          Promise.reject(new DOMException('Tap required','NotAllowedError'));
      };
      document.body.insertAdjacentHTML('beforeend',${JSON.stringify(blockMarkup('data-particle-count="500" data-show-motion-controls="false"'))});`);
    await waitFor('document.querySelector("canvas")?.getAttribute("role")==="button"');
    assert.equal(await evaluate('document.querySelector("button").getAttribute("aria-pressed")'), 'false');
    assert.equal(await evaluate('document.querySelector(".pendant-simulator__motion-controls").getClientRects().length'), 0);
    assert.match(await evaluate('document.querySelector(".pendant-simulator__hint").textContent'), /Tap the pendant/);
    assert.equal(await evaluate('document.querySelector("canvas").tabIndex'), 0);
    if(input==='pointer'||input==='touch'){
      const tap=await evaluate('document.querySelector("canvas").getBoundingClientRect().toJSON()');
      if(input==='touch'){
        await command('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
        await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tap.x+tap.width/2,y:tap.y+tap.height/2}]});
        await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }else{
        for(const type of ['mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{
          type,x:tap.x+tap.width/2,y:tap.y+tap.height/2,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1,
        });
      }
    }else{
      await evaluate('document.querySelector("canvas").focus()');
      for(const type of ['keyDown','keyUp'])await command('Input.dispatchKeyEvent',{
        type,key:input,code:input==='Enter'?'Enter':'Space',windowsVirtualKeyCode:input==='Enter'?13:32,
      });
    }
    await waitFor('document.querySelector("button").getAttribute("aria-pressed")==="true"');
    if(input==='touch')await command('Emulation.setTouchEmulationEnabled',{enabled:false});
    assert.deepEqual(await evaluate('__permissionCalls'), [false,false,true,true]);
    assert.equal(await evaluate('document.querySelector("canvas").getAttribute("role")'), null);
    assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation").length'), 2);
    await evaluate('document.querySelector("pendant-simulator").dataset.backgroundColor="#112233"');
    assert.equal(await evaluate('__permissionCalls.length'), 4);
    await evaluate('document.querySelector("pendant-simulator").remove()');
    assert.equal(await evaluate('__listeners.filter(record=>record.type==="devicemotion"||record.type==="deviceorientation"||record.target instanceof HTMLCanvasElement).length'), 0);
    assert.deepEqual(await evaluate('__csp'), []);
  }
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
  // Let the response reach a different LED occupancy, as in the scroll checks
  // above; an immediate image can match despite different particle velocities.
  await evaluate('__advance(60)');
  assert.equal(await evaluate('sameFluid()'), false, 're-enabling scroll motion takes effect on just that block');
  await evaluate(`window.toggleImage=toggleCanvas.toDataURL();moving.dataset.reactToScrolling='false'`);
  assert.equal(await evaluate(`moving.querySelector('canvas')===toggleCanvas && toggleCanvas.toDataURL()===toggleImage && PendantSimulator.mountSimulator(moving)===toggleCleanup`), true);
  assert.equal(await evaluate(`moving.querySelector('button').getAttribute('aria-pressed')`), 'true');
  assert.equal(await evaluate('__frames.size'), 2);
  await evaluate('moving.remove();fixed.remove()');
  assert.equal(await evaluate('__frames.size'), 0);
  assert.equal(await evaluate('__listeners.filter(record=>["scroll","resize","devicemotion","deviceorientation"].includes(record.type)).length'), 0);
  assert.deepEqual(await evaluate('__csp'), []);
  // Calibrate against the full image, not the block's heading/control height or
  // the invisible margins around the canvas's 316-unit circular display.
  await command('Emulation.setDeviceMetricsOverride', { width: 1400, height: 2200, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: `${origin}/photo-fixture` });
  await waitFor('document.querySelectorAll(".pendant-simulator__photo").length===2 && [...document.querySelectorAll(".pendant-simulator__photo")].every(img=>img.complete&&img.naturalWidth>0) && __frames.size===2');
  await evaluate(`window.photoHost=document.querySelector('pendant-simulator');window.photoRoot=photoHost.querySelector('.pendant-simulator');
    window.photoCanvas=photoHost.querySelector('canvas');window.photoCleanup=PendantSimulator.mountSimulator(photoHost);
    window.photoGeometry=()=>{
      const img=photoHost.querySelector('.pendant-simulator__photo').getBoundingClientRect();
      const display=photoHost.querySelector('.pendant-simulator__photo-display').getBoundingClientRect();
      const canvas=photoCanvas.getBoundingClientRect();
      return {x:(display.x+display.width/2-img.x)/img.width,y:(display.y+display.height/2-img.y)/img.height,
        diameter:display.width/img.width,aspect:img.height/img.width,square:display.height/display.width,
        visibleDiameter:canvas.width*316/400/display.width,
        canvasX:(canvas.x+canvas.width/2-display.x)/display.width,
        canvasY:(canvas.y+canvas.height/2-display.y)/display.height};
    };__advance(60)`);
  const checkPhotoGeometry = async (expected = { x: .52, y: .6, diameter: .3, aspect: 1.4 }) => {
    const geometry = await evaluate('photoGeometry()');
    for (const [key, value] of Object.entries({ ...expected, square: 1, visibleDiameter: 1, canvasX: .5, canvasY: .5 })) {
      assert.ok(Math.abs(geometry[key] - value) < .001, `${key}: ${JSON.stringify(geometry)}`);
    }
  };
  await checkPhotoGeometry();
  await evaluate('document.querySelector("#photo-pair").style.width="460px"');
  await checkPhotoGeometry();
  await evaluate('document.querySelector("#photo-pair").style.removeProperty("width")');
  assert.equal(await evaluate('photoCanvas.getContext("2d").getImageData(200,30,1,1).data[3]'), 0, 'photo mode does not draw a housing or rectangular background');
  for (const width of [900, 768, 390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 2200, deviceScaleFactor: 1, mobile: width < 600 });
    await checkPhotoGeometry();
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  }
  await evaluate(`window.photoImage=photoCanvas.toDataURL();photoHost.dataset.heading='A longer heading above the photograph';
    photoHost.dataset.showMotionControls='false';photoHost.dataset.verticalOffset='-10';
    photoHost.dataset.containerPadding='40';photoHost.dataset.radiusScale='50'`);
  await checkPhotoGeometry();
  assert.equal(await evaluate('photoHost.querySelector("canvas")===photoCanvas && photoCanvas.toDataURL()===photoImage && PendantSimulator.mountSimulator(photoHost)===photoCleanup'), true);
  await waitFor('photoHost.querySelector("button").getAttribute("aria-pressed")==="true"');
  await evaluate(`photoHost.dataset.photoCenterX='47';photoHost.dataset.photoCenterY='55';photoHost.dataset.photoDiameter='45'`);
  await checkPhotoGeometry({ x: .47, y: .55, diameter: .45, aspect: 1.4 });
  assert.equal(await evaluate('photoHost.querySelector("button").getAttribute("aria-pressed")'), 'true');
  // Actual touch stirring follows the small, positioned display on a phone.
  await evaluate(`photoHost.dataset.heading='';photoHost.dataset.showMotionControls='true';
    photoHost.querySelector('button').click();photoHost.dataset.photoCenterX='52';
    photoHost.dataset.photoCenterY='60';photoHost.dataset.photoDiameter='30';__advance(1)`);
  const touchDisplay = await evaluate('photoHost.querySelector(".pendant-simulator__photo-display").getBoundingClientRect().toJSON()');
  await evaluate('window.beforePhotoStir=photoCanvas.toDataURL()');
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  for (let step = 0; step <= 10; step++) {
    await command('Input.dispatchTouchEvent', { type: step === 0 ? 'touchStart' : 'touchMove',
      touchPoints: [{ x: touchDisplay.x + touchDisplay.width * (.3 + step * .04),
        y: touchDisplay.y + touchDisplay.height * (.85 - step * .04) }] });
  }
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await evaluate('__advance(12)');
  assert.equal(await evaluate('photoCanvas.toDataURL()===beforePhotoStir'), false);
  assert.equal(await evaluate('photoCanvas.toDataURL()===document.querySelectorAll("canvas")[1].toDataURL()'), false, 'photo instances stir independently');
  // Image replacement in an editor morph updates the frame in place, including
  // when its source attribute changes before the template's new contents arrive.
  await evaluate(`photoHost.dataset.photoVersion='landscape';
    {const img=photoHost.querySelector('template[data-pendant-simulator-photo]').content.querySelector('img');
      img.src='/landscape.svg';img.height=600;img.alt='Landscape pendant';}`);
  await waitFor('photoHost.querySelector(".pendant-simulator__photo")?.naturalHeight===600');
  await checkPhotoGeometry({ x: .52, y: .6, diameter: .3, aspect: .6 });
  assert.equal(await evaluate('photoHost.querySelector("canvas")===photoCanvas && photoHost.querySelector("img").alt==="Landscape pendant"'), true);
  await evaluate(`photoHost.querySelector('template[data-pendant-simulator-photo]').content.querySelector('img').src='/missing-photo.png';
    photoHost.dataset.photoVersion='missing'`);
  await waitFor('photoRoot.dataset.displayMode==="simulator"');
  assert.equal(await evaluate('photoCanvas.parentElement===photoRoot && !photoHost.querySelector(".pendant-simulator__photo-stage")'), true);
  await evaluate(`photoHost.querySelector('template[data-pendant-simulator-photo]').content.replaceChildren();
    photoHost.dataset.photoVersion='empty';photoHost.dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}))`);
  assert.equal(await evaluate('photoCanvas.parentElement===photoRoot && photoHost.querySelector("canvas")===photoCanvas'), true);
  await evaluate(`{const img=document.createElement('img');img.src='/photo.svg';img.width=1000;img.height=1400;
      photoHost.querySelector('template[data-pendant-simulator-photo]').content.append(img);}
    photoHost.dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}))`);
  await waitFor('photoHost.querySelector(".pendant-simulator__photo")?.naturalHeight===1400');
  await checkPhotoGeometry();
  await command('Page.captureScreenshot', { format: 'png' }).then(result => writeFile('/tmp/pendant-photo-mobile.png', Buffer.from(result.data, 'base64')));
  await evaluate(`photoHost.dataset.displayMode='simulator';photoHost.dataset.sizeMode='fixed';
    photoHost.dataset.radiusScale='100';photoHost.dataset.verticalOffset='0'`);
  assert.equal(await evaluate('photoCanvas.parentElement===photoRoot && photoRoot.dataset.displayMode==="simulator" && photoHost.querySelector("canvas")===photoCanvas'), true);
  await evaluate(`photoHost.dataset.displayMode='photo';
    window.disposedPhoto=photoHost.querySelector('img');for(const host of [...document.querySelectorAll('pendant-simulator')])host.remove()`);
  assert.equal(await evaluate('__frames.size'), 0);
  assert.equal(await evaluate('__resizeObservers.size'), 0);
  assert.equal(await evaluate('__listeners.filter(record=>record.target instanceof HTMLImageElement||record.target instanceof HTMLCanvasElement||["scroll","resize","devicemotion","deviceorientation"].includes(record.type)).length'), 0);
  assert.equal(await evaluate('disposedPhoto.hasAttribute("src")||disposedPhoto.hasAttribute("srcset")'), false);
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
  console.log('Browser checks passed: photo overlay alignment at desktop/tablet/phone widths; image replacement and failure fallback; photo touch stirring and cleanup; hidden controls enable motion automatically; touch/click and keyboard permission fallback; automatic history-cache resume; independent sensor cleanup; tall rounded rectangular on/off LEDs; percentage padding and vertical offset; container sizing; hidden controls and headings collapse; live updates preserve fluid and sensors; scroll inertia; single asset loading; editor reloads; CSP; mobile layout; standalone and Vite development.');
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
