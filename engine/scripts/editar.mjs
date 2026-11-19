#!/usr/bin/env node
// EDITOR dos cortes brutos do modo ao vivo.
// Você escolhe o clipe e o trecho (começo/fim); ele monta o vertical final:
// câmera em cima + gameplay embaixo + degradê com legenda palavra por palavra, gancho escrito nos 3 primeiros
// segundos, pausas cortadas, zoom nos picos de volume e sem as falas do jogo (só o streamer na legenda).
//
// Uso:
//   node scripts/editar.mjs                       (modo interativo: lista os clipes e pergunta)
//   node scripts/editar.mjs <clipe.mp4> [inicio] [fim]   (ex: 0:12 0:41)
// Opções: --subgancho "texto"  --sem-gancho  --sem-cortar-pausas  --sem-zoom  --manter-jogo  --crop x,y,w,h  --gancho "texto"
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {toCaptions} from '@remotion/install-whisper-cpp';
import {captionsToWords} from './palavras.mjs';

process.noDeprecation = true;
const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) opt[k] = true;
    else {
      opt[k] = n;
      i++;
    }
  } else pos.push(a);
}

const IS_WIN = process.platform === 'win32';
const HOME = path.join(os.homedir(), '.maquina-cortes-gta');
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
const LANG = cfg.language || 'pt';
const BASE_OUT = path.join(os.homedir(), 'Videos', 'cortes-ao-vivo');
const TOP = 760;
const GAME = 1920 - TOP;
const WDIR = path.join(HOME, 'ao-vivo', '.edicao');
fs.mkdirSync(WDIR, {recursive: true});
const CLAUDE = (() => {
  const exe = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
  if (fs.existsSync(exe)) return IS_WIN ? `"${exe}"` : exe;
  return 'claude';
})();
const MODELO = opt.modelo || cfg.whisperModel || 'small';
const THREADS = Math.max(2, Math.min(12, os.cpus().length - 1));

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}]`, ...a);
const run = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, {windowsHide: true, ...o});
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({code: -1, out, err: String(e)}));
    p.on('close', (code) => resolve({code, out, err}));
    if (o.input !== undefined) {
      p.stdin.write(o.input);
      p.stdin.end();
    }
  });
const parseT = (s, def) => {
  if (s === undefined || s === null || String(s).trim() === '') return def;
  const p = String(s).trim().split(':').map(Number);
  return p.reduce((a, b) => a * 60 + b, 0);
};
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const probe = (f) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f], {encoding: 'utf8'});
  const j = JSON.parse(r.stdout);
  return {W: j.streams[0].width, H: j.streams[0].height, D: Number(j.format.duration)};
};
const readJson = (f, d = {}) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

// ---------- whisper ----------
let n = 0;
function modelPath(m) {
  const f = path.join(HOME, 'whisper.cpp', `ggml-${m}.bin`);
  return fs.existsSync(f) && fs.statSync(f).size > 10e6 ? f : null;
}
async function whisperJson(wav, model, dtw = true) {
  const base = path.join(WDIR, `t${process.pid}_${++n}`);
  const exe = path.join(HOME, 'whisper.cpp', IS_WIN ? 'main.exe' : 'main');
  const args = ['-f', wav, '--output-file', base, '--output-json', '-ojf', '--max-len', '1', ...(dtw ? ['--dtw', model] : []), '-m', modelPath(model), '-l', LANG, '-t', String(THREADS), '-np'];
  const r = await run(exe, args, {cwd: path.join(HOME, 'whisper.cpp')});
  const jf = `${base}.json`;
  try {
    if (!fs.existsSync(jf)) throw new Error(`whisper falhou (${r.code}) ${r.err.slice(-200)}`);
    return JSON.parse(fs.readFileSync(jf, 'utf8'));
  } catch (e) {
    if (dtw && /JSON|Unexpected/i.test(e.message)) return whisperJson(wav, model, false);
    throw e;
  } finally {
    fs.rmSync(jf, {force: true});
  }
}
async function transcrever(wav) {
  const model = modelPath(MODELO) ? MODELO : modelPath('base') ? 'base' : 'small';
  const out = await whisperJson(wav, model);
  const {captions} = toCaptions({whisperCppOutput: out});
  return captionsToWords(captions).map((w) => ({text: w.text, t0: w.startMs / 1000, t1: w.endMs / 1000}));
}
// tira as falas do jogo (outro idioma) — o streamer fala português, os diálogos do GTA são em inglês
async function soStreamer(wav, ws) {
  if (!ws.length || opt['manter-jogo']) return ws;
  const frases = [];
  let cur = [];
  for (const w of ws) {
    const prev = cur[cur.length - 1];
    if (prev && (w.t0 - prev.t1 > 0.6 || /[.!?…]$/.test(prev.text) || w.t1 - cur[0].t0 > 10)) {
      frases.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) frases.push(cur);
  const exe = path.join(HOME, 'whisper.cpp', IS_WIN ? 'main.exe' : 'main');
  const lid = modelPath('base') || modelPath(MODELO) || modelPath('small');
  const fica = [];
  let tirou = 0;
  for (const f of frases) {
    const a = Math.max(0, f[0].t0 - 0.1);
    const d = Math.max(1, f[f.length - 1].t1 - a + 0.1);
    const chunk = wav.replace(/\.wav$/, '_frase.wav');
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', a.toFixed(2), '-t', d.toFixed(2), '-i', wav, '-c:a', 'pcm_s16le', chunk]);
    const r = await run(exe, ['-m', lid, '-f', chunk, '-l', 'auto', '-dl', '-t', String(THREADS)], {cwd: path.join(HOME, 'whisper.cpp')});
    fs.rmSync(chunk, {force: true});
    const lang = (r.out + r.err).match(/auto-detected language: (\w+)/)?.[1];
    if (lang && lang !== LANG) tirou += f.length;
    else fica.push(...f);
  }
  if (tirou) log(`🎮 ${tirou} palavra(s) do jogo tiradas da legenda`);
  return fica;
}

// ---------- Claude: gancho/título e câmera ----------
async function claude(prompt, extra = [], cwd) {
  const r = await Promise.race([
    run(CLAUDE, ['-p', '--output-format', 'text', '--model', opt['modelo-claude'] || 'sonnet', ...extra], {shell: IS_WIN, input: prompt, ...(cwd ? {cwd} : {})}),
    new Promise((res) => setTimeout(() => res({out: ''}), 90000)),
  ]);
  try {
    return JSON.parse(r.out.match(/\{[\s\S]*\}/)?.[0]);
  } catch {
    return null;
  }
}
async function titulo(texto, dur, streamer) {
  const d = await claude(`Você é o editor do canal de cortes ${cfg.profileName || ''} (GTA VI, TikTok e YouTube Shorts). Fala do streamer ${streamer} num corte de ${dur.toFixed(0)} s:
"${texto.slice(0, 2500)}"
Crie: 1) um GANCHO, o título grande escrito na tela no começo do vídeo (máx. 6 palavras, curiosidade/choque, PT-BR, sem emoji, estilo "CHEGOU A HORA DA VERDADE"), e um SUBGANCHO, o subtítulo pequeno embaixo dele que dá contexto ou aumenta a curiosidade (máx. 5 palavras, ex: "1 BILHÃO DE DÓLARES"); 2) um título de post que COMECE com o nome do streamer em maiúsculas (ex: "${streamer.toUpperCase()} ..."), porque o nome dele ajuda muito na busca do YouTube (pode ter 1 emoji); 3) uma legenda de post com 3 hashtags, sendo uma delas #${streamer.replace(/[^a-z0-9]/gi, '')}.
Responda SÓ o JSON: {"gancho": "...", "subgancho": "...", "titulo": "...", "legenda": "..."}`);
  return d || {};
}
async function acharCamera(src, W, H) {
  const jpg = path.join(WDIR, `quadro_${process.pid}.jpg`);
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', '2', '-i', src, '-frames:v', '1', '-q:v', '3', jpg]);
  const d = await claude(
    `Use a ferramenta Read para abrir a imagem ${jpg}. É um quadro de uma live, com ${W}x${H} pixels.
Ache a WEBCAM do streamer: o retângulo onde aparece a pessoa real (rosto/corpo filmado), normalmente num canto por cima do jogo. Não confunda com personagens do jogo, chat, alertas ou logos.
Se não tiver webcam, responda {"cam": null}. Senão responda {"cam": {"x": 0, "y": 0, "w": 0, "h": 0}} em pixels da imagem ORIGINAL (${W}x${H}). Responda SÓ o JSON.`,
    ['--allowedTools', 'Read', '--add-dir', IS_WIN ? `"${WDIR}"` : WDIR],
    WDIR,
  );
  const c = d?.cam;
  if (c && typeof c === 'object' && c.w >= 80 && c.h >= 60) {
    const x = Math.max(0, Math.round(c.x));
    const y = Math.max(0, Math.round(c.y));
    return {x, y, w: Math.min(Math.round(c.w), W - x), h: Math.min(Math.round(c.h), H - y)};
  }
  return null;
}

// ---------- legenda (.ass) ----------
const assTime = (t) => {
  t = Math.max(0, t);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
};
function writeAss(file, ws0, durS, hook, sub = '') {
  const ws = ws0
    .filter((w) => !/[\[\]]/.test(w.text))
    .map((w) => ({...w, text: w.text.replace(/[.,;:!?…"]+$/g, '').replace(/^["'“”«(¿¡-]+/g, '').toUpperCase()}))
    .filter((w) => w.text);
  const pages = [];
  let cur = [];
  for (const w of ws) {
    const chars = cur.reduce((k, x) => k + x.text.length, 0) + w.text.length;
    if (cur.length && (cur.length >= 3 || chars > 18 || w.t0 - cur[cur.length - 1].t1 > 0.6)) {
      pages.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) pages.push(cur);
  const esc = (t) => t.replace(/[{}\\]/g, '');
  const lines = [];
  pages.forEach((pg, pi) => {
    const pageEnd = Math.min(pages[pi + 1]?.[0].t0 ?? durS, pg[pg.length - 1].t1 + 0.25);
    pg.forEach((w, wi) => {
      const a = wi === 0 ? pg[0].t0 : w.t0;
      const b = wi === pg.length - 1 ? pageEnd : pg[wi + 1].t0;
      if (b <= a) return;
      const txt = pg.map((x, k) => (k === wi ? `{\\c&H0000D4FF&}${esc(x.text)}{\\c&H00FFFFFF&}` : esc(x.text))).join(' ');
      lines.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Cap,,0,0,0,,{\\an5\\pos(540,${TOP})}${txt}`);
    });
  });
  if (hook) {
    const limpa = (t) => esc(t).replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/\s+/g, ' ').trim().toUpperCase();
    const h = limpa(hook);
    // quebra o título em 2 linhas equilibradas
    const pal = h.split(' ');
    let best = h, diff = 1e9;
    for (let i = 1; i < pal.length; i++) {
      const a = pal.slice(0, i).join(' '), b = pal.slice(i).join(' ');
      const d = Math.abs(a.length - b.length);
      if (d < diff) { diff = d; best = `${a}\\N${b}`; }
    }
    if (h.length <= 14) best = h;
    const fim = assTime(Math.min(3.5, durS));
    const Y = TOP + 260;
    lines.push(`Dialogue: 2,${assTime(0)},${fim},Titulo,,0,0,0,,{\\an8\\pos(540,${Y})\\fscx118\\fscy118\\t(0,160,\\fscx100\\fscy100)\\fad(0,250)}${best}`);
    const sg = sub ? limpa(sub) : '';
    if (sg) {
      const ySub = Y + (best.includes('\\N') ? 2 : 1) * 100 + 14;
      lines.push(`Dialogue: 2,${assTime(0.12)},${fim},Sub,,0,0,0,,{\\an8\\pos(540,${ySub})\\fad(120,250)}${sg}`);
    }
  }
  fs.writeFileSync(
    file,
    `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Montserrat Black,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,10,4,5,40,40,0,1
Style: Titulo,Montserrat Black,96,&H0000B8F5,&H0000B8F5,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,7,4,8,50,50,0,1
Style: Sub,Montserrat ExtraBold,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,5,3,8,50,50,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
` + lines.join('\n') + '\n',
  );
  return ws.length;
}

// ---------- edição ----------
async function editar(clipe, inicio, fim) {
  const t0 = Date.now();
  const info = probe(clipe);
  inicio = Math.max(0, inicio ?? 0);
  fim = Math.min(info.D, fim ?? info.D);
  if (fim - inicio < 2) throw new Error('trecho muito curto');
  const canalDir = path.dirname(path.dirname(clipe)) === BASE_OUT ? path.dirname(clipe) : path.dirname(path.dirname(clipe));
  const canal = path.basename(canalDir);
  const lado = readJson(clipe.replace(/\.mp4$/, '.json'));
  let crop = opt.crop ? (([x, y, w, h]) => ({x, y, w, h}))(String(opt.crop).split(',').map(Number)) : lado.crop || readJson(path.join(HOME, 'cameras.json'))[lado.canal || canal] || null;
  const dir = path.join(WDIR, `${path.parse(clipe).name}_${Date.now()}`);
  fs.mkdirSync(dir, {recursive: true});

  log(`✂️  ${path.basename(clipe)} de ${mmss(inicio)} a ${mmss(fim)} (${(fim - inicio).toFixed(0)} s)`);
  const src = path.join(dir, 'src.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', inicio.toFixed(2), '-i', clipe, '-t', (fim - inicio).toFixed(2), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-r', '30', '-c:a', 'aac', '-b:a', '192k', src]);
  const wav = path.join(dir, 'a16.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const D = probe(src).D;

  if (!crop) {
    log('📷 Procurando a câmera do streamer…');
    crop = await acharCamera(src, info.W, info.H);
    if (crop) fs.writeFileSync(path.join(HOME, 'cameras.json'), JSON.stringify({...readJson(path.join(HOME, 'cameras.json')), [lado.canal || canal]: crop}, null, 2));
  }

  log('📝 Transcrevendo…');
  let ws = [];
  try {
    ws = await soStreamer(wav, await transcrever(wav));
  } catch (e) {
    log('Transcrição falhou:', e.message.slice(0, 160));
  }
  // --corrigir "ERRADO=CERTO;OUTRO=CERTO" troca palavras que o whisper errou (ex: "Air=Dead")
  if (typeof opt.corrigir === 'string') {
    for (const par of opt.corrigir.split(';')) {
      const [de, para] = par.split('=');
      if (!de || para === undefined) continue;
      const re = new RegExp(`^${de.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([.,!?…]*)$`, 'i');
      ws.forEach((w) => (w.text = w.text.replace(re, `${para.trim()}$1`)));
    }
  }
  const texto = ws.map((w) => w.text).join(' ');

  let meta = {gancho: typeof opt.gancho === 'string' ? opt.gancho : '', subgancho: typeof opt.subgancho === 'string' ? opt.subgancho : '', titulo: '', legenda: ''};
  if (texto && !opt['sem-gancho']) {
    log('🤖 Criando gancho e título…');
    meta = {...(await titulo(texto, D, opt.streamer || lado.canal || canal)), ...(meta.gancho ? {gancho: meta.gancho} : {}), ...(meta.subgancho ? {subgancho: meta.subgancho} : {})};
  }

  // pausas
  let keep = [{from: 0, to: D}];
  if (!opt['sem-cortar-pausas']) {
    const sd = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'silencedetect=noise=-33dB:d=0.45', '-f', 'null', '-']);
    const sil = [];
    let open = null;
    for (const line of sd.err.split(/\r?\n/)) {
      const a = line.match(/silence_start: ([\d.]+)/);
      const b = line.match(/silence_end: ([\d.]+)/);
      if (a) open = Number(a[1]);
      if (b && open !== null) {
        sil.push({start: open, end: Number(b[1])});
        open = null;
      }
    }
    if (open !== null) sil.push({start: open, end: D});
    keep = [];
    let cur = 0;
    for (const x of sil) {
      const cf = Math.max(x.start + 0.12, 0);
      const ct = Math.min(x.end - 0.12, D);
      if (ct - cf < 0.25) continue;
      if (cf - cur > 0.3) keep.push({from: cur, to: cf});
      cur = ct;
    }
    if (D - cur > 0.3) keep.push({from: cur, to: D});
    if (!keep.length) keep = [{from: 0, to: D}];
  }
  let acc = 0;
  for (const k of keep) {
    k.out = acc;
    acc += k.to - k.from;
  }
  const newD = acc;
  const remap = (t) => {
    for (const k of keep) if (t < k.to) return k.out + Math.max(0, t - k.from);
    return newD;
  };
  const wsNew = ws.map((w) => ({...w, t0: remap(w.t0), t1: Math.max(remap(w.t0) + 0.1, remap(w.t1))}));

  // zoom nos picos
  const peaks = [];
  if (!opt['sem-zoom'] && crop) {
    const r = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', wav, '-af', 'ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-', '-f', 'null', '-']);
    const pts = [];
    let tc = 0;
    for (const line of r.out.split(/\r?\n/)) {
      const a = line.match(/pts_time:([\d.]+)/);
      if (a) tc = Number(a[1]);
      const m = line.match(/lavfi\.r128\.M=(-?[\d.]+)/);
      if (m) pts.push({t: tc, v: Number(m[1])});
    }
    const vals = pts.map((p) => p.v).filter((v) => v > -70).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)] ?? -30;
    for (const p of pts.filter((q) => q.v > med + 8 && q.v > -26).sort((a, b) => b.v - a.v)) {
      const tn = remap(p.t);
      if (peaks.every((q) => Math.abs(q - tn) > 4) && tn > 0.5) peaks.push(tn);
      if (peaks.length >= 4) break;
    }
  }
  const zExpr = peaks.length
    ? '1+0.18*' + peaks.map((pk) => `clip((it-${(pk - 0.15).toFixed(2)})/0.12,0,1)*clip((${(pk + 1.4).toFixed(2)}-it)/0.25,0,1)`).reduce((a, b) => `max(${a},${b})`)
    : '1';

  const grad = path.join(dir, 'degrade.png');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1080x360', '-frames:v', '1', '-vf', "format=rgba,geq=r=0:g=0:b=0:a='245*(0.5+0.5*cos(PI*abs(Y-180)/180))'", grad]);
  const nWords = writeAss(path.join(dir, 'legenda.ass'), wsNew, newD, opt['sem-gancho'] ? '' : meta.gancho || meta.titulo, opt['sem-gancho'] ? '' : meta.subgancho || '');
  try {
    const fd = new URL('../fonts/', import.meta.url);
    fs.mkdirSync(path.join(dir, 'fonts'), {recursive: true});
    for (const f of fs.readdirSync(fd)) if (f.endsWith('.ttf')) fs.copyFileSync(new URL(f, fd), path.join(dir, 'fonts', f));
  } catch {}
  const sel = keep.map((k) => `between(t,${k.from.toFixed(3)},${k.to.toFixed(3)})`).join('+');

  const nome = path.parse(clipe).name.replace(/-BRUTO$/, '');
  const outDir = canalDir;
  let k = 1;
  let out;
  do out = path.join(outDir, `${nome}-EDITADO${k > 1 ? '-' + k : ''}.mp4`);
  while (fs.existsSync(out) && ++k);
  const build = (subs) => {
    let f = `[0:v]select='${sel}',setpts=N/30/TB,split=2[c][g];`;
    if (crop) {
      f += `[c]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=1620:${TOP * 1.5}:force_original_aspect_ratio=increase,crop=1620:${TOP * 1.5},` +
        `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x${TOP}:fps=30[cam];` +
        `[g]scale=1080:${GAME}:force_original_aspect_ratio=increase,crop=1080:${GAME}[game];[cam][game]vstack[st];`;
    } else {
      // sem câmera: tela inteira no topo, gameplay (centro) embaixo
      f += `[c]scale=1080:${TOP}:force_original_aspect_ratio=increase,crop=1080:${TOP}[cam];[g]scale=1080:${GAME}:force_original_aspect_ratio=increase,crop=1080:${GAME}[game];[cam][game]vstack[st];`;
    }
    f += `[st][1:v]overlay=0:${TOP - 180}:shortest=1[v1];[0:a]aselect='${sel}',asetpts=N/SR/TB[a]`;
    let last = 'v1';
    if (subs) {
      f += `;[v1]ass=legenda.ass:fontsdir=fonts[v2]`;
      last = 'v2';
    }
    return ['-y', '-v', 'error', '-i', src, '-loop', '1', '-i', grad, '-filter_complex', f, '-map', `[${last}]`, '-map', '[a]', '-t', newD.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out];
  };
  log('🎬 Montando…');
  let r = await run('ffmpeg', build(true), {cwd: dir});
  if (r.code !== 0 || !fs.existsSync(out)) {
    log('Legenda falhou, saindo sem legenda:', r.err.slice(-200));
    r = await run('ffmpeg', build(false), {cwd: dir});
  }
  if (!fs.existsSync(out)) throw new Error('não consegui montar o vídeo: ' + r.err.slice(-300));
  fs.writeFileSync(out.replace(/\.mp4$/, '.txt'), [`Título: ${meta.titulo || ''}`, `Gancho: ${meta.gancho || ''}`, `Subtítulo: ${meta.subgancho || ''}`, `Legenda: ${meta.legenda || ''}`, '', `Fala: ${texto}`].join('\n') + '\n');
  fs.rmSync(dir, {recursive: true, force: true});
  process.stdout.write('\x07');
  log(`✅ Pronto em ${((Date.now() - t0) / 1000).toFixed(0)} s → ${out}`);
  log(`   ${(D - newD) > 0.5 ? `-${(D - newD).toFixed(1)} s de pausas` : 'sem pausas'} | ${peaks.length} zoom(s) | ${nWords} palavras na legenda${meta.gancho ? ` | gancho: "${meta.gancho}"` : ''}`);
  if (meta.titulo) log(`   Título: ${meta.titulo}`);
  if (meta.legenda) log(`   Legenda: ${meta.legenda}`);
  return out;
}

// ---------- modo interativo ----------
function listarBrutos() {
  const out = [];
  if (!fs.existsSync(BASE_OUT)) return out;
  for (const canal of fs.readdirSync(BASE_OUT)) {
    const d = path.join(BASE_OUT, canal, 'brutos');
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.mp4')) out.push(path.join(d, f));
  }
  return out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 20);
}

if (pos[0]) {
  await editar(path.resolve(pos[0]), parseT(pos[1], 0), parseT(pos[2], undefined));
} else {
  const rl = readline.createInterface({input: process.stdin});
  const linhas = rl[Symbol.asyncIterator]();
  const ask = async (q) => {
    process.stdout.write(q);
    const {value, done} = await linhas.next();
    return done ? 'q' : value;
  };
  for (;;) {
    const lista = listarBrutos();
    if (!lista.length) {
      console.log('Nenhum clipe bruto ainda (eles ficam em Vídeos\\cortes-ao-vivo\\<canal>\\brutos).');
      break;
    }
    console.log('\nClipes brutos (mais novos primeiro):');
    lista.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}) ${path.basename(path.dirname(path.dirname(f)))} / ${path.basename(f)}  (${mmss(probe(f).D)})`));
    const a = (await ask('\nNúmero do clipe (q = sair): ')).trim();
    if (a.toLowerCase() === 'q' || a === '') break;
    const f = lista[Number(a) - 1];
    if (!f) continue;
    const ini = await ask('Começo (ex 0:12 — ENTER = do início): ');
    const fim = await ask('Fim (ex 0:41 — ENTER = até o final): ');
    try {
      await editar(f, parseT(ini, 0), parseT(fim, undefined));
    } catch (e) {
      log('Erro:', e.message);
    }
  }
  rl.close();
}
