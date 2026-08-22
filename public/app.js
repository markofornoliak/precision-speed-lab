const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  sizeMB: 100,
  connections: 4,
  precise: true,
  running: false,
  aborters: [],
  downloadSeries: [],
  uploadSeries: [],
  totalBytes: 0,
};

const els = {
  start: $('#startBtn'), stop: $('#stopBtn'), phase: $('#phaseLabel'), speed: $('#speedValue'),
  ping: $('#pingValue'), jitter: $('#jitterValue'), down: $('#downloadValue'), up: $('#uploadValue'),
  gauge: $('#gaugeProgress'), sizeHint: $('#sizeHint'), conn: $('#connections'), precision: $('#precisionToggle'),
  chart: $('#speedChart'), confidence: $('#confidenceValue'), confidenceText: $('#confidenceText'), data: $('#dataValue'),
  serverStatus: $('#serverStatus'), footerInfo: $('#footerInfo'),
  loadedDown: $('#loadedDownValue'), loadedUp: $('#loadedUpValue'), stability: $('#stabilityValue'), bufferbloat: $('#bufferbloatValue')
};

function formatSpeed(v) {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1000) return v.toFixed(1);
  if (v >= 100) return v.toFixed(1);
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

function setGauge(v) {
  const max = v < 100 ? 100 : v < 500 ? 500 : v < 1000 ? 1000 : v < 2500 ? 2500 : 10000;
  const ratio = Math.max(0, Math.min(1, v / max));
  els.gauge.style.strokeDashoffset = String(415 * (1 - ratio));
}

function updateLive(v) {
  els.speed.textContent = formatSpeed(v);
  setGauge(v);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length % 2 ? s[mid] : (s[mid-1] + s[mid]) / 2;
}
function mean(arr) { return arr.reduce((a,b)=>a+b,0) / (arr.length || 1); }
function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(v => (v-m) ** 2)));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function resetResults() {
  state.downloadSeries = []; state.uploadSeries = []; state.totalBytes = 0;
  ['ping','jitter','down','up','loadedDown','loadedUp','stability','bufferbloat'].forEach(k => els[k].textContent = '—');
  els.confidence.textContent = '—'; els.confidenceText.textContent = 'Будет рассчитана по разбросу результатов.';
  els.data.textContent = '0 MB'; updateLive(0); drawChart();
}

function setPhase(text) { els.phase.textContent = text; }
function addBytes(n) { state.totalBytes += n; els.data.textContent = `${(state.totalBytes/1e6).toFixed(state.totalBytes < 1e8 ? 1 : 0)} MB`; }

async function pingTest() {
  setPhase('PING');
  const samples = [];
  for (let i=0;i<12;i++) {
    if (!state.running) throw new Error('stopped');
    const t0 = performance.now();
    await fetch(`/api/ping?t=${Date.now()}-${i}`, {cache:'no-store'});
    const dt = performance.now() - t0;
    if (i > 1) samples.push(dt);
    els.ping.textContent = median(samples).toFixed(1);
    updateLive(0);
    await sleep(45);
  }
  const p = median(samples);
  const diffs = samples.slice(1).map((x,i)=>Math.abs(x-samples[i]));
  const j = mean(diffs);
  els.ping.textContent = p.toFixed(1);
  els.jitter.textContent = j.toFixed(1);
  return {ping:p, jitter:j};
}

function splitBytes(totalBytes, streams) {
  const base = Math.floor(totalBytes / streams);
  const out = Array(streams).fill(base);
  out[out.length - 1] += totalBytes - base * streams;
  return out;
}

async function downloadRun(totalBytes, streams, record=true) {
  const started = performance.now();
  let received = 0;
  let lastT = started, lastBytes = 0;
  const aborters = splitBytes(totalBytes, streams).map(()=>new AbortController());
  state.aborters.push(...aborters);

  const jobs = splitBytes(totalBytes, streams).map(async (bytes, idx) => {
    const r = await fetch(`/api/download?bytes=${bytes}&r=${crypto.randomUUID()}`, {cache:'no-store', signal:aborters[idx].signal});
    if (!r.ok || !r.body) throw new Error('download failed');
    const reader = r.body.getReader();
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      received += value.byteLength;
      addBytes(value.byteLength);
      const now = performance.now();
      if (now - lastT >= 220) {
        const mbps = ((received - lastBytes) * 8) / ((now - lastT) / 1000) / 1e6;
        updateLive(mbps);
        if (record) state.downloadSeries.push({t:(now-started)/1000, v:mbps});
        lastT = now; lastBytes = received;
        drawChart();
      }
    }
  });
  await Promise.all(jobs);
  const sec = (performance.now() - started) / 1000;
  return totalBytes * 8 / sec / 1e6;
}

const uploadChunk = new Blob([new Uint8Array(1024 * 1024)]);
async function uploadRun(totalBytes, streams, record=true) {
  const started = performance.now();
  let sent = 0;
  let lastT = started, lastBytes = 0;
  const chunkSize = Math.min(1024*1024, Math.max(64*1024, Math.floor(totalBytes / Math.max(streams*6,1))));
  const fullChunk = chunkSize === uploadChunk.size ? uploadChunk : new Blob([new Uint8Array(chunkSize)]);
  let remaining = totalBytes;

  async function worker(workerId) {
    while (state.running) {
      const size = Math.min(chunkSize, remaining);
      if (size <= 0) break;
      remaining -= size;
      const controller = new AbortController();
      state.aborters.push(controller);
      const body = size === fullChunk.size ? fullChunk : fullChunk.slice(0,size);
      const r = await fetch(`/api/upload?r=${crypto.randomUUID()}&w=${workerId}`, {method:'POST', body, cache:'no-store', signal:controller.signal});
      if (!r.ok) throw new Error('upload failed');
      sent += size; addBytes(size);
      const now = performance.now();
      if (now - lastT >= 220) {
        const mbps = ((sent - lastBytes) * 8) / ((now - lastT) / 1000) / 1e6;
        updateLive(mbps);
        if (record) state.uploadSeries.push({t:(now-started)/1000, v:mbps});
        lastT = now; lastBytes = sent;
        drawChart();
      }
    }
  }
  await Promise.all(Array.from({length:streams}, (_,i)=>worker(i)));
  const sec = (performance.now() - started) / 1000;
  return totalBytes * 8 / sec / 1e6;
}


async function collectLoadedLatency(flag, label) {
  const samples = [];
  let seq = 0;
  while (flag.active && state.running) {
    const t0 = performance.now();
    try {
      await fetch(`/api/ping?loaded=${label}&r=${Date.now()}-${seq++}`, {cache:'no-store'});
      const dt = performance.now() - t0;
      if (flag.active) samples.push(dt);
    } catch {}
    await sleep(110);
  }
  return samples;
}

function bufferbloatGrade(idle, down, up) {
  const extra = Math.max(0, Math.max(down || idle, up || idle) - idle);
  if (extra <= 5) return 'A+';
  if (extra <= 15) return 'A';
  if (extra <= 30) return 'B';
  if (extra <= 60) return 'C';
  if (extra <= 100) return 'D';
  return 'F';
}

function throughputStability(series) {
  const vals = series.map(x=>x.v).filter(v=>Number.isFinite(v) && v > 0);
  if (vals.length < 3) return null;
  const m = mean(vals);
  const cv = m ? stddev(vals)/m : 1;
  return Math.max(0, Math.min(100, 100 * (1 - cv)));
}

async function runThroughput(kind) {
  const totalBytes = state.sizeMB * 1_000_000;
  const runs = state.precise ? (state.sizeMB >= 250 ? 2 : 3) : 1;
  const values = [];
  const loadedPings = [];
  for (let i=0;i<runs;i++) {
    if (!state.running) throw new Error('stopped');
    setPhase(`${kind === 'down' ? 'DOWNLOAD' : 'UPLOAD'} ${i+1}/${runs}`);
    const flag = {active:true};
    const sampler = collectLoadedLatency(flag, kind);
    const value = kind === 'down'
      ? await downloadRun(totalBytes, state.connections, true)
      : await uploadRun(totalBytes, state.connections, true);
    flag.active = false;
    const lp = await sampler;
    loadedPings.push(...lp);
    const loadedMedian = median(loadedPings);
    (kind === 'down' ? els.loadedDown : els.loadedUp).textContent = loadedMedian ? loadedMedian.toFixed(1) : '—';
    values.push(value);
    updateLive(value);
    (kind === 'down' ? els.down : els.up).textContent = formatSpeed(median(values));
    if (i < runs-1) await sleep(350);
  }
  return {values, loadedPings};
}

function confidenceFrom(values) {
  if (values.length < 2) return {pct:null, cv:null};
  const m = mean(values), sd = stddev(values);
  const cv = m ? sd/m : 1;
  const pct = Math.max(75, Math.min(99.9, 100 - cv*100*1.7));
  return {pct, cv};
}

async function startTest() {
  if (state.running) return;
  state.running = true; state.aborters = []; resetResults();
  state.connections = Number(els.conn.value);
  els.start.disabled = true; els.stop.hidden = false;
  try {
    const idle = await pingTest();
    const downResult = await runThroughput('down');
    await sleep(350);
    const upResult = await runThroughput('up');
    const downValues = downResult.values, upValues = upResult.values;
    const d = median(downValues), u = median(upValues);
    const loadedD = median(downResult.loadedPings), loadedU = median(upResult.loadedPings);
    els.loadedDown.textContent = loadedD ? loadedD.toFixed(1) : '—';
    els.loadedUp.textContent = loadedU ? loadedU.toFixed(1) : '—';
    const stability = throughputStability([...state.downloadSeries, ...state.uploadSeries]);
    els.stability.textContent = stability == null ? '—' : stability.toFixed(1);
    els.bufferbloat.textContent = bufferbloatGrade(idle.ping, loadedD, loadedU);
    els.down.textContent = formatSpeed(d); els.up.textContent = formatSpeed(u);
    const confs = [confidenceFrom(downValues), confidenceFrom(upValues)].filter(x=>x.pct);
    if (confs.length) {
      const pct = Math.min(...confs.map(x=>x.pct));
      els.confidence.textContent = `${pct.toFixed(1)}%`;
      els.confidenceText.textContent = pct > 97 ? 'Очень низкий разброс между прогонами.' : pct > 92 ? 'Низкий разброс между прогонами.' : 'Канал заметно менялся во время теста.';
    } else {
      els.confidence.textContent = '1 прогон';
      els.confidenceText.textContent = 'Включите «Высокая точность» для оценки разброса.';
    }
    setPhase('ГОТОВО'); updateLive(d);
  } catch (e) {
    if (state.running) {
      setPhase('ОШИБКА');
      els.serverStatus.textContent = 'Ошибка теста';
      console.error(e);
    } else setPhase('ОСТАНОВЛЕНО');
  } finally {
    state.running = false; state.aborters = [];
    els.start.disabled = false; els.stop.hidden = true;
  }
}

function stopTest() {
  state.running = false;
  state.aborters.forEach(a => { try { a.abort(); } catch {} });
  state.aborters = [];
}

function drawChart() {
  const canvas = els.chart;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width*dpr)); canvas.height = Math.floor(280*dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const w = rect.width, h = 280, pad = 26;
  ctx.clearRect(0,0,w,h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  for (let i=0;i<5;i++) { const y=pad+(h-pad*2)*i/4; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  const all = [...state.downloadSeries, ...state.uploadSeries];
  const maxV = Math.max(10, ...all.map(p=>p.v))*1.1;
  const maxT = Math.max(1, ...all.map(p=>p.t));
  function plot(series, stroke) {
    if (!series.length) return;
    ctx.beginPath();
    series.forEach((p,i)=>{
      const x = pad + (w-pad*2)*(p.t/maxT), y = h-pad-(h-pad*2)*(p.v/maxV);
      i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
    });
    ctx.strokeStyle=stroke; ctx.lineWidth=2; ctx.stroke();
  }
  plot(state.downloadSeries, '#42d8ff'); plot(state.uploadSeries, '#5ff3b5');
  ctx.fillStyle='rgba(140,157,178,.65)'; ctx.font='11px system-ui';
  ctx.fillText('0', 4, h-7); ctx.fillText(`${Math.round(maxV)} Mbps`, 4, 14);
}

$$('#sizeSelector button').forEach(btn => btn.addEventListener('click', () => {
  if (state.running) return;
  $$('#sizeSelector button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); state.sizeMB = Number(btn.dataset.size); els.sizeHint.textContent = `${state.sizeMB} MB`;
}));
els.precision.addEventListener('click', () => {
  if (state.running) return;
  state.precise = !state.precise;
  els.precision.classList.toggle('on', state.precise); els.precision.setAttribute('aria-pressed', String(state.precise));
});
els.start.addEventListener('click', startTest); els.stop.addEventListener('click', stopTest);
window.addEventListener('resize', drawChart);

(async () => {
  try {
    const t0=performance.now(); const r=await fetch(`/api/info?t=${Date.now()}`, {cache:'no-store'}); const info=await r.json();
    els.serverStatus.textContent=`Сервер готов · ${Math.round(performance.now()-t0)} ms`;
    els.footerInfo.textContent=`HTTP/${info.protocol} · ${info.remoteFamily || 'network'}`;
  } catch { els.serverStatus.textContent='Сервер недоступен'; }
  drawChart();
})();
