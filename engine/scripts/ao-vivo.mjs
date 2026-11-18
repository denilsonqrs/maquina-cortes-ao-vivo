#!/usr/bin/env node
// MODO AO VIVO da máquina de cortes: grava a live ENQUANTO ela roda, acha os picos (chat explodindo,
// grito, palavrão, "olha isso") e já entrega o corte pronto — sem esperar a live acabar.
//
// Uso (dentro da pasta engine):
//   node scripts/ao-vivo.mjs <link_da_live> [opções]
//
// Opções:
//   --nome x            nome da pasta (padrão: canal tirado do link)
//   --crop x,y,w,h      recorte da câmera do streamer (pixels do vídeo), igual ao "crop" do cuts.json
//   --foco x,y          enquadramento (%) quando não tem crop. Padrão 50,35
//   --bottom arquivo    vídeo da metade de baixo (padrão: bottom.mp4 da máquina, senão a própria live)
//   --duracao 60        duração máxima de cada corte em segundos (padrão 60)
//   --limiar 3          sensibilidade da detecção (menor = mais cortes). Padrão 3 com chat, 2.5 sem chat
//   --sem-claude        não pergunta ao Claude Code; corta direto pelo pico
//   --modelo-claude m   modelo do `claude -p` (padrão: sonnet)
//   --streamlink        grava com streamlink (pula anúncio da Twitch) em vez do yt-dlp
//   --saida pasta       onde salvar os cortes (padrão: Vídeos/cortes-ao-vivo/<nome>)
//   --guardar-min 40    quantos minutos de live manter em disco (padrão 40)
//   --so-rapido         só gera a versão RÁPIDA (sem legenda/Remotion) + horizontal
//   --sem-horizontal    não gera a versão horizontal 16:9
//   --teste arquivo     simula uma live com um vídeo local (para testar hoje)
//
// Enquanto roda, no terminal:
//   ENTER          corta os últimos 60 s na hora (você viu algo e quer na mão)
//   90 + ENTER     corta os últimos 90 s
//   q + ENTER      encerra
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {transcribe, toCaptions, downloadWhisperModel} from '@remotion/install-whisper-cpp';
import WebSocket from 'ws';
import {captionsToWords} from './palavras.mjs';

// ---------------- argumentos ----------------
const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opt[k] = true;
    else {
      opt[k] = next;
      i++;
    }
  } else pos.push(a);
}
const url = pos[0] || (opt.teste ? 'teste' : null);
if (!url) {
  console.error('Uso: node scripts/ao-vivo.mjs <link_da_live> [--crop x,y,w,h] [--nome x] [--sem-claude] ...');
  process.exit(1);
}

const IS_WIN = process.platform === 'win32';
process.noDeprecation = true;
// acha o Claude Code mesmo se o terminal ainda não tiver ele no PATH (instalador nativo do Windows)
const CLAUDE = (() => {
  const exe = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'claude.exe' : 'claude');
  if (fs.existsSync(exe)) return IS_WIN ? `"${exe}"` : exe;
  return 'claude';
})(); // esconde o aviso DEP0190 do Node (inofensivo)
const HOME = path.join(os.homedir(), '.maquina-cortes-gta');
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
const LANG = cfg.language || 'pt';
const MODEL = cfg.whisperModel || 'small';

const twitch = url.match(/twitch\.tv\/([A-Za-z0-9_]+)/i)?.[1]?.toLowerCase() ?? null;
const kick = url.match(/kick\.com\/([A-Za-z0-9_-]+)/i)?.[1]?.toLowerCase() ?? null;
const canal =
  twitch ||
  url.match(/kick\.com\/([A-Za-z0-9_-]+)/i)?.[1] ||
  url.match(/youtube\.com\/@([A-Za-z0-9_.-]+)/i)?.[1] ||
  (opt.teste ? path.parse(opt.teste).name : 'live');
const nome = String(opt.nome || canal).replace(/[^\w.-]+/g, '_');
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const WORK = path.join(HOME, 'ao-vivo', `${nome}-${stamp}`);
const SEGS = path.join(WORK, 'segs');
const OUT = path.resolve(opt.saida || path.join(os.homedir(), 'Videos', 'cortes-ao-vivo', nome));
fs.mkdirSync(SEGS, {recursive: true});
fs.mkdirSync(OUT, {recursive: true});

const SEG = 10; // segundos por pedaço gravado (menor = menos atraso)
const MAX_DUR = Number(opt.duracao || 60);
const KEEP = Number(opt['guardar-min'] || 40) * 60;
const COOLDOWN = 60; // segundos mínimos entre dois cortes automáticos
const POST = 20; // segundos que espera depois do pico (para pegar a reação)
// sensibilidade: com chat lido (Twitch ou Kick conectado) 3; sem chat (YouTube, Kick bloqueada) 2,3
const limiar = () => (opt.limiar ? Number(opt.limiar) : twitch || kickOk ? 3 : 2.3);
const CLAUDE_MODEL = opt['modelo-claude'] || 'sonnet';
const CROPS = path.join(HOME, 'cameras.json'); // câmera de cada streamer, achada uma vez e reaproveitada
const readCrops = () => {
  try {
    return JSON.parse(fs.readFileSync(CROPS, 'utf8'));
  } catch {
    return {};
  }
};
let crop = opt.crop ? (([x, y, w, h]) => ({x, y, w, h}))(String(opt.crop).split(',').map(Number)) : readCrops()[canal] || null;
if (opt.crop) fs.writeFileSync(CROPS, JSON.stringify({...readCrops(), [canal]: crop}, null, 2));
// a versão completa (Remotion) pesa muito e segura os outros cortes: só gera com --completo
const SO_RAPIDO = !opt['completo'];
// modo manual (padrão): só corta no ENTER. --auto liga a detecção automática de picos
const AUTO = !!opt.auto;
const MARCA = !!opt['marca']; // marca d'água (logo + @) desligada por padrão; --marca liga
const TOP_LIVE = 760; // altura da câmera no vertical (o resto, 1160 px, é gameplay)
const focus = opt.foco ? (([x, y]) => ({x, y}))(String(opt.foco).split(',').map(Number)) : {x: 50, y: 35};

// ---------------- utilidades ----------------
const hms = (s) => {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
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
const has = (cmd, args = ['--version']) => spawnSync(cmd, args, {windowsHide: true}).status === 0;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const std = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const slug = (s) =>
  String(s || 'corte')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'corte';
const beep = () => process.stdout.write('\x07');

// ---------------- checagens ----------------
if (!has('ffmpeg', ['-version'])) {
  console.error('ffmpeg não encontrado no PATH.');
  process.exit(1);
}
const useStreamlink = !!opt.streamlink || (!!twitch && !opt['yt-dlp'] && !opt.teste && has('streamlink'));
if (!opt.teste && !useStreamlink && !has('yt-dlp')) {
  console.error('yt-dlp não encontrado. Instale com:  winget install yt-dlp   (depois feche e abra o terminal)');
  process.exit(1);
}
if (!opt.teste && useStreamlink && !has('streamlink')) {
  console.error('streamlink não encontrado. Instale com:  winget install streamlink');
  process.exit(1);
}
let claudeOk = false;
if (!opt['sem-claude']) {
  const t = spawnSync(CLAUDE, ['-p', '--output-format', 'text', '--model', opt['modelo-claude'] || 'sonnet'], {shell: IS_WIN, windowsHide: true, input: 'Responda só: OK', encoding: 'utf8', timeout: 90000});
  claudeOk = t.status === 0 && /ok/i.test(t.stdout || '');
  if (claudeOk) console.log('✅ Claude Code respondendo.');
  else {
    console.log('❌ O Claude Code NÃO respondeu. Sem ele não tem título, filtro de momentos nem detecção automática da câmera.');
    console.log('   Erro:', String(t.error?.message || t.stderr || t.stdout || 'sem resposta').trim().slice(0, 400));
    console.log('   Teste no PowerShell:  claude -p "oi"   (se pedir login, rode  claude  e faça login)');
  }
}

// ---------------- estado ----------------
const segments = []; // {file, abs0, dur, wallStart, wallEnd}
let total = 0; // segundos gravados (linha do tempo contínua)
const words = []; // {text, t0, t1} em segundos absolutos
const loud = new Map(); // segundo absoluto -> loudness máxima (LUFS momentânea)
const chat = []; // {wall, text}
let lastClipAt = -Infinity;
let pending = null; // pico esperando o "depois"
let lastScore = 0;
let part = 0;
let offline = false;
let lastRecErr = '';
let waitingLive = false;
let stopping = false;
const transcriptFile = path.join(WORK, 'transcricao.txt');
const momentsFile = path.join(WORK, 'momentos.jsonl');

// ---------------- 1) gravação contínua em pedaços ----------------
function startRecorder() {
  part++;
  const list = path.join(SEGS, `lista_p${part}.csv`);
  const pattern = path.join(SEGS, `p${part}_%05d.ts`);
  const ffArgs = ['-hide_banner', '-loglevel', 'error'];
  let src = null;
  if (opt.teste) ffArgs.push('-re', '-i', opt.teste);
  else ffArgs.push('-i', 'pipe:0');
  ffArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'segment', '-segment_time', String(SEG),
    '-reset_timestamps', '1', '-segment_list', list, '-segment_list_type', 'csv', '-segment_list_flags', '+live', pattern);
  if (opt.teste) {
    // simulação: reencoda para ter keyframes a cada 2 s como numa live de verdade
    ffArgs.splice(ffArgs.indexOf('-c'), 2, '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-c:a', 'aac');
  }
  const ff = spawn('ffmpeg', ffArgs, {windowsHide: true, stdio: [opt.teste ? 'ignore' : 'pipe', 'ignore', 'pipe']});
  ff.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (waitingLive || offline || /pipe:0|Invalid data|Output file|nothing was|Error opening|End of file|h264 @|hevc @|Last message repeated|decode_slice|reference|out of range|overflow|illegal|mmco|no frame/i.test(s)) return;
    if (s && !/Non-monotonous|DTS|PTS/i.test(s)) log('ffmpeg:', s.slice(0, 200));
  });
  if (!opt.teste) {
    src = useStreamlink
      ? spawn('streamlink', ['--twitch-disable-ads', '--stdout', url, 'best'], {windowsHide: true})
      : spawn('yt-dlp', ['--no-part', '--quiet', '--no-warnings', '-f', opt.formato || 'best[height<=1080]/best', '-o', '-', url], {windowsHide: true});
    src.stdout.pipe(ff.stdin);
    src.stdin?.end();
    ff.stdin.on('error', () => {});
    src.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (!s) return;
      lastRecErr = s.split(/\r?\n/).filter((l) => /error|erro/i.test(l)).pop() || lastRecErr;
      if (/offline|No playable streams|not currently live|is not live|will begin|Premieres|does not exist/i.test(s)) {
        offline = true;
        return;
      }
      if (!waitingLive) log('gravador:', s.slice(0, 200));
    });
    src.on('error', (e) => log('gravador falhou:', e.message));
  }
  watchList(list);
  const segsAtStart = segments.length;
  ff.on('close', () => {
    if (stopping) return;
    if (opt.teste) {
      log('Fim do vídeo de teste. Esperando os cortes terminarem… (q + ENTER para sair)');
      return;
    }
    src?.kill();
    if (segments.length === segsAtStart && (offline || segments.length === 0)) {
      // a live ainda não começou (ou acabou): fica esperando sem encher o terminal
      if (!waitingLive) {
        log(`⏳ Não consegui pegar a live de ${canal} agora (offline ou erro). Vou tentando a cada 30 s.`);
        if (lastRecErr) log(`   Motivo: ${lastRecErr.slice(0, 300)}`);
      }
      waitingLive = true;
      offline = false;
      setTimeout(startRecorder, 30000);
      return;
    }
    log('A gravação caiu (live caiu, anúncio ou rede). Reconectando em 5 s…');
    setTimeout(startRecorder, 5000);
  });
}

// acompanha a lista do ffmpeg: cada linha nova = um pedaço completo
const seen = new Map();
function watchList(list) {
  const p = part;
  seen.set(list, 0);
  const tick = () => {
    if (!fs.existsSync(list)) return;
    const lines = fs.readFileSync(list, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = seen.get(list); i < lines.length; i++) {
      const [name, a, b] = lines[i].split(',');
      const dur = Number(b) - Number(a);
      if (!(dur > 0)) continue;
      const now = Date.now();
      const seg = {file: path.join(SEGS, name), abs0: total, dur, wallEnd: now, wallStart: now - dur * 1000, part: p};
      segments.push(seg);
      total += dur;
      if (waitingLive) {
        waitingLive = false;
        log(`🔴 ${canal} entrou ao vivo! Gravando.`);
      }
      analysisQueue.push(seg);
    }
    seen.set(list, lines.length);
    pumpAnalysis();
  };
  const iv = setInterval(tick, 1500);
  tick();
  return iv;
}

// ---------------- 2) chat da Twitch (anônimo, sem login) ----------------
function startChat() {
  if (!twitch) return;
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  ws.on('open', () => {
    ws.send('PASS SCHMOOPIIE');
    ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
    ws.send(`JOIN #${twitch}`);
    log(`Chat da Twitch conectado (#${twitch}).`);
  });
  ws.on('message', (raw) => {
    for (const line of String(raw).split('\r\n')) {
      if (line.startsWith('PING')) ws.send('PONG :tmi.twitch.tv');
      const m = line.match(/ PRIVMSG #\S+ :(.*)$/);
      if (m) chat.push({wall: Date.now(), text: m[1]});
    }
    while (chat.length && chat[0].wall < Date.now() - (KEEP + 120) * 1000) chat.shift();
  });
  ws.on('close', () => !stopping && setTimeout(startChat, 3000));
  ws.on('error', () => {});
}

// ---------------- 2b) chat da Kick (Pusher público) ----------------
let kickOk = false;
async function kickChatroomId() {
  const cache = path.join(HOME, 'kick-salas.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(cache, 'utf8'));
  } catch {}
  if (saved[kick] === 123456) delete saved[kick];
  if (String(opt['kick-sala']) === '123456') {
    log('Chat da Kick: 123456 era só um número de EXEMPLO. Tire o --kick-sala do comando (ou use o número de verdade).');
    opt['kick-sala'] = undefined;
  }
  if (opt['kick-sala']) {
    fs.writeFileSync(cache, JSON.stringify({...saved, [kick]: Number(opt['kick-sala'])}, null, 2));
    return Number(opt['kick-sala']);
  }
  if (saved[kick]) return saved[kick];
  for (const u of [`https://kick.com/api/v2/channels/${kick}`, `https://kick.com/api/v1/channels/${kick}`]) {
    try {
      const r = await fetch(u, {headers: {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'application/json'}});
      if (!r.ok) continue;
      const j = await r.json();
      const id = j?.chatroom?.id;
      if (id) {
        fs.writeFileSync(cache, JSON.stringify({...saved, [kick]: id}, null, 2));
        return id;
      }
    } catch {}
  }
  return null;
}
async function startKickChat() {
  if (!kick) return;
  const id = await kickChatroomId();
  if (!id) {
    log(`Chat da Kick: a Kick bloqueou a consulta automática. Abra no navegador https://kick.com/api/v2/channels/${kick} ,`);
    log('   procure  "chatroom":{"id":NÚMERO  e rode de novo com  --kick-sala NÚMERO  (só precisa uma vez por canal).');
    return;
  }
  const connect = () => {
    const ws = new WebSocket('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false');
    ws.on('open', () => ws.send(JSON.stringify({event: 'pusher:subscribe', data: {auth: '', channel: `chatrooms.${id}.v2`}})));
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        if (m.event === 'pusher:ping') ws.send(JSON.stringify({event: 'pusher:pong', data: {}}));
        if (m.event === 'pusher_internal:subscription_succeeded' && !kickOk) {
          kickOk = true;
          log(`Chat da Kick conectado (${kick}).`);
        }
        if (/ChatMessage/i.test(m.event || '')) {
          const d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
          chat.push({wall: Date.now(), text: String(d?.content || '')});
        }
      } catch {}
    });
    ws.on('close', () => !stopping && setTimeout(connect, 3000));
    ws.on('error', () => {});
  };
  connect();
}

// converte horário real do chat para o tempo da live gravada
function wallToAbs(wall) {
  for (const s of segments) if (wall >= s.wallStart && wall < s.wallEnd) return s.abs0 + (wall - s.wallStart) / 1000;
  return null;
}

// ---------------- 3) análise de cada pedaço: volume + transcrição ----------------
const analysisQueue = [];
let analyzing = false;
let camBusy = false;
let camTries = 0;
let camLast = -Infinity;
let srcSize = null;

// pede ao Claude Code para achar a webcam do streamer num quadro da live
async function findCamera(seg, recheck = false) {
  if (camBusy) {
    while (camBusy) await new Promise((r) => setTimeout(r, 500));
    return;
  }
  camBusy = true;
  camLast = Date.now();
  if (!recheck) camTries++;
  try {
    const jpg = path.join(WORK, 'quadro.jpg');
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', '3', '-i', seg.file, '-frames:v', '1', '-q:v', '3', jpg]);
    const pr = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', seg.file]);
    const [W, H] = (pr.out.trim().split(/\r?\n/)[0] || '1920,1080').split(',').map(Number);
    srcSize = {W, H};
    if (!claudeOk) {
      log(`Sem Claude para achar a câmera. Passe --crop x,y,w,h (quadro salvo em ${jpg}).`);
      camTries = 99;
      return;
    }
    if (!recheck) log('🤖 Procurando a câmera do streamer no quadro…');
    const prompt = `Use a ferramenta Read para abrir a imagem ${jpg}. É um quadro de uma live, com ${W}x${H} pixels.
Ache a WEBCAM do streamer: o retângulo onde aparece a pessoa real (rosto/corpo filmado), normalmente num canto por cima do jogo. Não confunda com personagens do jogo, chat, alertas ou logos.
Se for tela de anúncio/intervalo ("Commercial break"), tela de espera, ou não tiver webcam, responda {"cam": null}.
Se a live for só a câmera em tela cheia (sem jogo), responda {"cam": "cheia"}.
Senão, responda {"cam": {"x": 0, "y": 0, "w": 0, "h": 0}} em pixels da imagem ORIGINAL (${W}x${H}), justo nas bordas da janela da câmera.
Responda SÓ o JSON.`;
    const r = await Promise.race([
      run(CLAUDE, ['-p', '--output-format', 'text', '--model', CLAUDE_MODEL, '--allowedTools', 'Read', '--add-dir', IS_WIN ? `"${WORK}"` : WORK], {shell: IS_WIN, input: prompt, cwd: WORK}),
      new Promise((res) => setTimeout(() => res({out: ''}), 120000)),
    ]);
    const d = JSON.parse(r.out.match(/\{[\s\S]*\}/)?.[0] || '{}');
    const c = d.cam;
    if (c && typeof c === 'object' && c.w >= 80 && c.h >= 60 && c.w <= W * 0.9) {
      const novo = {x: Math.max(0, Math.round(c.x)), y: Math.max(0, Math.round(c.y)), w: Math.round(c.w), h: Math.round(c.h)};
      novo.w = Math.min(novo.w, W - novo.x);
      novo.h = Math.min(novo.h, H - novo.y);
      if (novo.w < 80 || novo.h < 60) {
        if (!recheck) log('📷 Câmera achada fora do quadro; ignorando.');
        return;
      }
      const mudou = !crop || Math.abs(novo.x - crop.x) > 40 || Math.abs(novo.y - crop.y) > 40 || Math.abs(novo.w - crop.w) > 60;
      if (recheck && !mudou) return;
      crop = novo;
      fs.writeFileSync(CROPS, JSON.stringify({...readCrops(), [canal]: crop}, null, 2));
      await run('ffmpeg', ['-y', '-v', 'error', '-i', jpg, '-vf', `drawbox=x=${crop.x}:y=${crop.y}:w=${crop.w}:h=${crop.h}:color=lime:t=6`, path.join(WORK, 'quadro-camera.jpg')]);
      log(`📷 ${recheck ? 'A cena mudou — câmera atualizada' : 'Câmera achada'}: --crop ${crop.x},${crop.y},${crop.w},${crop.h} (confira em quadro-camera.jpg; fica salva para as próximas lives)`);
    } else if (c === 'cheia') {
      log('📷 Live só com câmera em tela cheia — vou usar o layout com fundo desfocado.');
      camTries = 99;
    } else if (recheck) {
      // na reconferência não achou (anúncio, tela de transição): mantém a câmera atual
    } else {
      log(`📷 Não achei a câmera agora (anúncio ou cena sem câmera). Tento de novo em 1,5 min. (${camTries}/6)`);
    }
  } catch (e) {
    log('📷 Erro procurando a câmera:', e.message.slice(0, 120));
  } finally {
    camBusy = false;
  }
}
async function pumpAnalysis() {
  if (analyzing || !analysisQueue.length) return;
  analyzing = true;
  while (analysisQueue.length) {
    // pega todos os pedaços que acumularam (até 6 = 1 min) e transcreve num lote só: bem mais rápido que um por um
    let batch = analysisQueue.splice(0, 6);
    if (AUTO && analysisQueue.length >= 3) {
      // está mais de 1 min atrasado: mede volume desses pedaços mas não transcreve; transcreve só o mais recente
      for (const seg of batch) {
        try {
          await analyze(seg);
        } catch {}
        fs.rmSync(seg.file.replace(/\.ts$/, '.wav'), {force: true});
      }
      if (!pumpAnalysis.warned || Date.now() - pumpAnalysis.warned > 120000) {
        log(`⏩ Transcrição atrasou ${analysisQueue.length * SEG}s — pulando para o ao vivo (os cortes desse trecho são transcritos na hora de montar).`);
        pumpAnalysis.warned = Date.now();
      }
      detect();
      continue;
    }
    for (const seg of batch) {
      try {
        await analyze(seg);
      } catch (e) {
        log('erro analisando pedaço:', e.message);
      }
    }
    if (AUTO) {
      try {
        await transcribeBatch(batch);
      } catch (e) {
        log('erro na transcrição:', e.message.slice(0, 160));
      }
    }
    for (const seg of batch) fs.rmSync(seg.file.replace(/\.ts$/, '.wav'), {force: true});
    if (AUTO) {
      log(`gravado ${hms(total)} | atraso ${analysisQueue.length * SEG}s | último pico ${lastScore.toFixed(1)}/${limiar()}${pending ? ' | pico em espera' : ''}`);
      detect();
    } else if (!pumpAnalysis.lastLog || Date.now() - pumpAnalysis.lastLog > 60000) {
      pumpAnalysis.lastLog = Date.now();
      log(`gravando… ${hms(total)} | ENTER = corta os últimos 60 s`);
    }
    cleanup();
  }
  analyzing = false;
}

const KW_FALA = /\b(caralho|porra|puta|meu deus|n[aã]o acredito|que isso|olha isso|olha esse|socorro|morri|mds|nossa|ca[cç]amba|filho da|jesus|absurdo|insano|bugou|mano do c[eé]u)\b/i;
const KW_CHAT = /(k{4,}|KEKW|LUL|OMEGALUL|ICANT|clip|clipa|\?{3,}|POG|monkaS|LMAO|Kappa|[!]{3,}|AAAA)/i;

async function analyze(seg) {
  const wav = seg.file.replace(/\.ts$/, '.wav');
  const chk = await run('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, seg.dur / 2 - 1)), '-i', seg.file, '-t', '1', '-f', 'null', '-']);
  const errs = chk.err.split(/\r?\n/).filter((l) => /error|illegal|overflow|out of range|no frame/i.test(l)).length;
  if (errs > 5) {
    seg.bad = true;
    if (!segments.some((x) => x !== seg && x.bad && x.abs0 > seg.abs0 - 30)) log('⚠️  Trecho corrompido (provável anúncio da Twitch) — fica fora dos cortes.');
  }
  await run('ffmpeg', ['-y', '-v', 'error', '-i', seg.file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  if (claudeOk && !camBusy && !seg.bad && segments.length >= 6) {
    if (!crop && camTries < 6 && Date.now() - camLast > 90000) findCamera(seg);
    else if (crop && Date.now() - camLast > 6 * 60000) findCamera(seg, true); // a cena pode ter mudado (espera -> jogo)
  }
  // volume momentâneo a cada 0,1 s -> máximo por segundo
  const r = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', wav, '-af', 'ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-', '-f', 'null', '-']);
  let tcur = 0;
  let got = 0;
  for (const line of (r.out + '\n' + r.err).split(/\r?\n/)) {
    const a = line.match(/pts_time:([\d.]+)/);
    if (a) tcur = Number(a[1]);
    const m = line.match(/lavfi\.r128\.M=(-?[\d.]+)/) || line.match(/t:\s*([\d.]+)\s+TARGET.*?M:\s*(-?[\d.]+)/);
    if (!m) continue;
    const t = m.length > 2 ? Number(m[1]) : tcur;
    const v = Number(m.length > 2 ? m[2] : m[1]);
    got++;
    const sec = Math.floor(seg.abs0 + t);
    if (v > -70) loud.set(sec, Math.max(loud.get(sec) ?? -70, v));
  }
  if (!got && !analyze.loudWarned) {
    analyze.loudWarned = true;
    log('Aviso: não consegui medir o volume deste pedaço; a detecção vai usar só chat e fala.');
  }
}

// vários terminais abertos ao mesmo tempo dividem os núcleos (senão um atrapalha o outro)
const INST_DIR = path.join(HOME, 'ao-vivo', '.instancias');
fs.mkdirSync(INST_DIR, {recursive: true});
const instFile = path.join(INST_DIR, String(process.pid));
const beat = () => {
  try {
    fs.writeFileSync(instFile, String(Date.now()));
  } catch {}
};
beat();
setInterval(beat, 20000).unref();
process.on('exit', () => {
  try {
    fs.rmSync(instFile, {force: true});
  } catch {}
});
const instancias = () => {
  try {
    return Math.max(1, fs.readdirSync(INST_DIR).filter((f) => Date.now() - fs.statSync(path.join(INST_DIR, f)).mtimeMs < 60000).length);
  } catch {
    return 1;
  }
};
const threads = () => Math.max(2, Math.min(12, Math.floor((os.cpus().length - 1) / instancias())));
// ao vivo usa um modelo mais leve (base) para acompanhar a live; a versão completa continua com o da config (small)
let LIVE_MODEL = opt['modelo-live'] || 'base';
async function prepLiveModel() {
  if (LIVE_MODEL === MODEL) return;
  const f = path.join(HOME, 'whisper.cpp', `ggml-${LIVE_MODEL}.bin`);
  if (fs.existsSync(f) && fs.statSync(f).size > 10e6) return;
  try {
    log(`Baixando o modelo "${LIVE_MODEL}" do whisper (só na primeira vez, ~150 MB)…`);
    await downloadWhisperModel({model: LIVE_MODEL, folder: path.join(HOME, 'whisper.cpp'), printOutput: false});
    if (!fs.existsSync(f) || fs.statSync(f).size < 10e6) {
      fs.rmSync(f, {force: true});
      throw new Error('download incompleto');
    }
    log('Modelo baixado.');
  } catch (e) {
    log(`Não consegui baixar o modelo ${LIVE_MODEL} (${e.message.slice(0, 80)}); usando ${MODEL}.`);
    LIVE_MODEL = MODEL;
  }
}
// chama o whisper.cpp direto, cada vez com um arquivo de saída próprio (a função do Remotion usa sempre o mesmo
// tmp.json: duas transcrições ao mesmo tempo se atropelavam e travavam/quebravam o JSON). Uma de cada vez, com prioridade
// para a transcrição de corte, e com limite de tempo.
let whisperChain = Promise.resolve();
let whisperN = 0;
function transcribeSafe(inputPath, {prioridade = false} = {}) {
  const job = () => runWhisper(inputPath);
  if (prioridade) return job(); // corte não espera a fila da transcrição ao vivo
  const p = whisperChain.then(job, job);
  whisperChain = p.catch(() => {});
  return p;
}
async function runWhisper(inputPath, dtw = true) {
  const dir = path.join(WORK, 'whisper-tmp');
  fs.mkdirSync(dir, {recursive: true});
  const base = path.join(dir, `t${process.pid}_${++whisperN}`);
  const exe = path.join(HOME, 'whisper.cpp', IS_WIN ? 'main.exe' : 'main');
  const model = path.join(HOME, 'whisper.cpp', `ggml-${LIVE_MODEL}.bin`);
  const args = ['-f', inputPath, '--output-file', base, '--output-json', '-ojf', '--max-len', '1', ...(dtw ? ['--dtw', LIVE_MODEL.replace(/\.en$/, '')] : []),
    '-m', model, '-l', LANG, '-t', String(threads()), '-np'];
  const durS = Math.max(10, fs.statSync(inputPath).size / 32000);
  const r = await new Promise((resolve) => {
    const pr = spawn(exe, args, {cwd: path.join(HOME, 'whisper.cpp'), windowsHide: true});
    let err = '';
    pr.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    pr.stdout.on('data', () => {});
    const timer = setTimeout(() => pr.kill(), (durS * 4 + 60) * 1000);
    pr.on('error', (e) => resolve({code: -1, err: String(e)}));
    pr.on('close', (code) => {
      clearTimeout(timer);
      resolve({code, err});
    });
  });
  const jf = `${base}.json`;
  try {
    if (!fs.existsSync(jf)) throw new Error(`whisper não gerou saída (código ${r.code}) ${r.err.slice(-200)}`);
    const json = JSON.parse(fs.readFileSync(jf, 'utf8'));
    return json;
  } catch (e) {
    if (dtw && /JSON|Unexpected token/i.test(e.message)) return runWhisper(inputPath, false);
    if (/initialize whisper context/i.test(e.message) && LIVE_MODEL !== MODEL) {
      log(`Modelo ${LIVE_MODEL} com problema; usando ${MODEL}.`);
      LIVE_MODEL = MODEL;
      return runWhisper(inputPath, dtw);
    }
    throw e;
  } finally {
    fs.rmSync(jf, {force: true});
  }
}
const whisperOpts = () => ({
  whisperPath: path.join(HOME, 'whisper.cpp'),
  whisperCppVersion: '1.5.5',
  model: LIVE_MODEL,
  tokenLevelTimestamps: true,
  language: LANG,
  printOutput: false,
  additionalArgs: ['-t', String(threads())],
});

// transcreve um lote de pedaços seguidos numa chamada só do whisper
async function transcribeBatch(batch) {
  const ok = batch.filter((s) => fs.existsSync(s.file.replace(/\.ts$/, '.wav')));
  if (!ok.length) return;
  let wav = ok[0].file.replace(/\.ts$/, '.wav');
  if (ok.length > 1) {
    const lst = path.join(SEGS, `lote_${ok[0].abs0.toFixed(0)}.txt`);
    fs.writeFileSync(lst, ok.map((s) => `file '${s.file.replace(/\.ts$/, '.wav').replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    wav = path.join(SEGS, `lote_${ok[0].abs0.toFixed(0)}.wav`);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', wav]);
    fs.rmSync(lst, {force: true});
  }
  const base = ok[0].abs0;
  try {
    const out = await transcribeSafe(wav);
    const {captions} = toCaptions({whisperCppOutput: out});
    const mine = captionsToWords(captions).map((w) => ({text: w.text, t0: base + w.startMs / 1000, t1: base + w.endMs / 1000}));
    words.push(...mine);
    ok.forEach((s) => (s.transcribed = true));
    if (mine.length) fs.appendFileSync(transcriptFile, `[${hms(base)}] ${mine.map((w) => w.text).join(' ')}\n`);
  } catch (e) {
    if (opt['teste-legenda']) {
      const fake = 'OLHA ISSO MANO NÃO ACREDITO QUE ELE FEZ ISSO KKKK'.split(' ');
      for (const seg of ok) for (let k = 0; k * 0.4 < seg.dur - 0.4; k++) words.push({text: fake[k % fake.length], t0: seg.abs0 + k * 0.4, t1: seg.abs0 + k * 0.4 + 0.35});
    }
    if (!transcribeBatch.warned) log('Transcrição indisponível:', e.message.slice(0, 160));
    transcribeBatch.warned = true;
  } finally {
    if (ok.length > 1) fs.rmSync(wav, {force: true});
  }
}

// ---------------- 4) detecção de pico ----------------
function windowStats(t0, t1) {
  let l = -70;
  for (let s = Math.floor(t0); s < t1; s++) l = Math.max(l, loud.get(s) ?? -70);
  const msgs = chat.filter((c) => {
    const a = wallToAbs(c.wall);
    return a !== null && a >= t0 && a < t1;
  });
  const kw = words.filter((w) => w.t0 >= t0 && w.t0 < t1 && KW_FALA.test(w.text)).length +
    (KW_FALA.test(words.filter((w) => w.t0 >= t0 && w.t0 < t1).map((w) => w.text).join(' ')) ? 1 : 0);
  return {loud: l, chat: msgs.length, chatKw: msgs.filter((m) => KW_CHAT.test(m.text)).length, kw};
}

function detect() {
  if (pending && total >= pending.peak + POST) {
    const p = pending;
    pending = null;
    decide(p);
  }
  if (pending || total < 60) return;
  // linha de base: últimos 5 min (menos os 30 s mais recentes)
  const baseFrom = Math.max(0, total - 300);
  const base = [];
  for (let t = baseFrom; t + 5 <= total - 30; t += 5) base.push(windowStats(t, t + 5));
  if (base.length < 6) return;
  const lm = mean(base.map((b) => b.loud));
  const ls = std(base.map((b) => b.loud));
  const cm = mean(base.map((b) => b.chat));
  const cs = std(base.map((b) => b.chat));
  let best = null;
  for (let t = Math.max(total - SEG - 5, 0); t + 5 <= total; t += 1) {
    const w = windowStats(t, t + 5);
    const zl = Math.max(0, (w.loud - lm) / (ls + 1.5));
    const zc = twitch || kickOk ? Math.max(0, (w.chat - cm) / (cs + 1)) : 0;
    const score = zc + 0.8 * zl + 1.0 * Math.min(w.kw, 3) + 0.15 * Math.min(w.chatKw, 10);
    if (!best || score > best.score) {
      // segundo mais alto dentro da janela = momento do pico
      let ps = t + 2.5;
      let pv = -71;
      for (let k = t; k < t + 5; k++) if ((loud.get(k) ?? -70) > pv) {
        pv = loud.get(k) ?? -70;
        ps = k;
      }
      best = {t, score, peakSec: zl > 0.5 ? ps : t + 2.5, ...w};
    }
  }
  lastScore = best.score;
  if (best.score >= limiar() && best.t - lastClipAt > COOLDOWN) {
    pending = {peak: best.peakSec, score: best.score, info: best};
    lastClipAt = pending.peak; // evita disparar duas vezes no mesmo momento
    log(`⚡ Pico em ${hms(pending.peak)} (score ${best.score.toFixed(1)}) — esperando ${POST}s da reação…`);
    fs.appendFileSync(momentsFile, JSON.stringify({em: hms(pending.peak), ...best}) + '\n');
  }
}

// ---------------- 5) Claude Code decide o corte ----------------
function contextText(from, to) {
  const lines = [];
  let cur = [];
  let start = null;
  for (const w of words.filter((x) => x.t0 >= from && x.t0 < to)) {
    if (start === null) start = w.t0;
    cur.push(w.text);
    if (/[.!?…]$/.test(w.text) || cur.length >= 18) {
      lines.push(`[${w.t0 === start ? start.toFixed(1) : start.toFixed(1)}s] ${cur.join(' ')}`);
      cur = [];
      start = null;
    }
  }
  if (cur.length) lines.push(`[${start.toFixed(1)}s] ${cur.join(' ')}`);
  return lines.join('\n') || '(sem transcrição neste trecho)';
}

async function decide(p) {
  const from = Math.max(0, p.peak - 75);
  const to = Math.min(total, p.peak + POST);
  let clip = {start: Math.max(from, p.peak - Math.min(40, MAX_DUR - POST)), end: to, id: `pico-${hms(p.peak).replace(/:/g, '')}`, titulo: '', legenda: '', motivo: 'pico automático'};
  if (claudeOk) {
    const msgs = chat
      .map((c) => ({a: wallToAbs(c.wall), text: c.text}))
      .filter((c) => c.a !== null && c.a >= p.peak - 15 && c.a <= to)
      .slice(-40)
      .map((c) => `[${c.a.toFixed(0)}s] ${c.text}`)
      .join('\n');
    const prompt = `Você é o editor do canal de cortes ${cfg.profileName || ''} (GTA VI, TikTok e YouTube Shorts). Uma live está rolando AGORA e quem posta o corte primeiro ganha.
A detecção automática achou um pico aos ${p.peak.toFixed(1)}s (volume/chat/palavras fortes, score ${p.score.toFixed(1)}).

Transcrição do streamer (tempos em segundos da gravação):
${contextText(from, to)}

Chat na hora do pico:
${msgs || '(sem chat)'}

Decida se vale um corte e onde começa e termina. Regras: entre 15 e ${MAX_DUR} segundos; comece no contexto mínimo que faz o momento ter graça (nada de enrolação antes); termine logo depois da reação; início >= ${from.toFixed(1)} e fim <= ${to.toFixed(1)}. Recuse se for só barulho sem momento (anúncio, música, conversa parada).
Responda SÓ com um JSON, sem texto fora dele:
{"cortar": true, "inicio": 0.0, "fim": 0.0, "id": "slug-curto-sem-acento", "titulo": "título chamativo em PT-BR para o post", "legenda": "legenda curta com 3 hashtags", "motivo": "por que é bom"}`;
    log('🤖 Perguntando ao Claude Code se vale o corte…');
    const r = await Promise.race([
      run(CLAUDE, ['-p', '--output-format', 'text', '--model', CLAUDE_MODEL], {shell: IS_WIN, input: prompt}),
      new Promise((res) => setTimeout(() => res({code: -2, out: '', err: 'timeout'}), 90000)),
    ]);
    const json = r.out.match(/\{[\s\S]*\}/)?.[0];
    try {
      const d = JSON.parse(json);
      if (d.cortar === false) {
        log(`🤖 Claude recusou: ${d.motivo || ''}`);
        fs.appendFileSync(momentsFile, JSON.stringify({em: hms(p.peak), recusado: d.motivo}) + '\n');
        return;
      }
      const s = Math.max(from, Number(d.inicio));
      let e = Math.min(to, Number(d.fim));
      if (e - s > MAX_DUR) e = s + MAX_DUR;
      if (e - s >= 8) clip = {start: s, end: e, id: slug(d.id || d.titulo), titulo: d.titulo || '', legenda: d.legenda || '', motivo: d.motivo || ''};
      log(`🤖 Claude aprovou: "${clip.titulo}" (${(clip.end - clip.start).toFixed(0)} s)`);
    } catch {
      log('🤖 Não entendi a resposta do Claude; vou cortar pelo pico mesmo.', (r.err || '').slice(0, 120));
    }
  }
  clipQueue.push(clip);
  pumpClips();
}

// ---------------- 6) monta o corte: versão RÁPIDA + versão completa (sua skill) ----------------
const clipQueue = [];
let clipping = false;
const inUse = new Set();
async function pumpClips() {
  if (clipping || !clipQueue.length) return;
  clipping = true;
  while (clipQueue.length) {
    const c = clipQueue.shift();
    try {
      await makeClip(c);
    } catch (e) {
      log(`Erro no corte ${c.id}:`, e.message);
    }
  }
  clipping = false;
}

async function makeClip(c) {
  const n = String(fs.readdirSync(OUT).filter((f) => f.endsWith('.txt')).length + 1).padStart(2, '0');
  const id = `${n}-${slug(c.id)}`;
  const dir = path.join(WORK, 'cortes', id);
  fs.mkdirSync(dir, {recursive: true});
  const all = segments.filter((s) => s.abs0 + s.dur > c.start && s.abs0 < c.end && fs.existsSync(s.file));
  const segs = all.filter((s) => !s.bad);
  if (!segs.length) throw new Error(all.length ? 'trecho era anúncio/corrompido' : 'trecho já saiu do disco');
  if (segs.length < all.length) {
    // tira o anúncio do meio e encurta o corte do mesmo tanto
    const lost = all.filter((s) => s.bad).reduce((n, s) => n + s.dur, 0);
    c = {...c, start: Math.max(c.start, segs[0].abs0), end: Math.max(segs[0].abs0 + 5, c.end - lost)};
    log(`   (pulei ${lost.toFixed(0)} s de anúncio/trecho corrompido)`);
  }
  segs.forEach((s) => inUse.add(s.file));
  const list = path.join(dir, 'lista.txt');
  fs.writeFileSync(list, segs.map((s) => `file '${s.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const t0 = Date.now();
  const ss = (c.start - segs[0].abs0).toFixed(2);
  const dur = (c.end - c.start).toFixed(2);
  if (!opt['editar-na-hora']) {
    // padrão: só salva o trecho BRUTO (16:9, sem legenda) — você escolhe a parte e edita depois com o editar.bat
    const bdir = path.join(OUT, 'brutos');
    fs.mkdirSync(bdir, {recursive: true});
    const nb = String(fs.readdirSync(bdir).filter((f) => f.endsWith('.mp4')).length + 1).padStart(2, '0');
    const bruto = path.join(bdir, `${nb}-${canal}-${hms(c.end).replace(/:/g, '')}-BRUTO.mp4`);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ss', ss, '-t', dur,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', bruto]);
    segs.forEach((s) => inUse.delete(s.file));
    fs.writeFileSync(bruto.replace(/\.mp4$/, '.json'), JSON.stringify({canal, crop, live: hms(c.start) + '–' + hms(c.end)}, null, 2));
    fs.rmSync(dir, {recursive: true, force: true});
    beep();
    log(`✅ Bruto ${nb} salvo em ${((Date.now() - t0) / 1000).toFixed(0)} s → ${bruto}`);
    return;
  }
  // versão RÁPIDA primeiro (vertical com fundo desfocado), direto dos pedaços — é a que você posta antes de todo mundo
  const rapido = path.join(OUT, `${id}-RAPIDO.mp4`);
  await renderRapido({list, ss, dur, dir, out: rapido, c, segs});
  const info = [`Título: ${c.titulo}`, `Legenda: ${c.legenda}`, `Motivo: ${c.motivo}`, `Trecho da live: ${hms(c.start)} – ${hms(c.end)}`].join('\n');
  fs.writeFileSync(path.join(OUT, `${id}.txt`), info + '\n');
  beep();
  log(`✅ RÁPIDO pronto em ${((Date.now() - t0) / 1000).toFixed(0)} s → ${rapido}`);
  if (!c.titulo && claudeOk && c.texto) {
    const prompt = `Você é o editor do canal de cortes ${cfg.profileName || ''} (GTA VI, TikTok e YouTube Shorts). Este é o que o streamer fala num corte de ${(c.end - c.start).toFixed(0)} s:
"${c.texto.slice(0, 2500)}"
Crie um título chamativo (PT-BR, curto, pode ter 1 emoji) e uma legenda de post com 3 hashtags. Responda SÓ o JSON: {"titulo": "...", "legenda": "..."}`;
    const r = await Promise.race([run(CLAUDE, ['-p', '--output-format', 'text', '--model', CLAUDE_MODEL], {shell: IS_WIN, input: prompt}), new Promise((res) => setTimeout(() => res({out: ''}), 60000))]);
    try {
      const d = JSON.parse(r.out.match(/\{[\s\S]*\}/)?.[0]);
      c.titulo = d.titulo || '';
      c.legenda = d.legenda || '';
      fs.writeFileSync(path.join(OUT, `${id}.txt`), [`Título: ${c.titulo}`, `Legenda: ${c.legenda}`, `Trecho da live: ${hms(c.start)} – ${hms(c.end)}`, '', `Fala: ${c.texto}`].join('\n') + '\n');
    } catch {}
  }
  if (c.titulo) log(`   Título sugerido: ${c.titulo}`);
  // versão HORIZONTAL (16:9, 1920x1080) com a logo no canto — para YouTube normal, Facebook, etc.
  if (!opt['sem-horizontal']) {
    const horiz = path.join(OUT, `${id}-HORIZONTAL.mp4`);
    const logo = path.join(HOME, cfg.logo || 'logo.png');
    const hasLogo = MARCA && fs.existsSync(logo);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...(hasLogo ? ['-i', logo] : []), '-ss', ss, '-t', dur, '-filter_complex',
      '[0:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2' +
        (hasLogo ? '[v];[1:v]scale=170:-1,format=rgba,colorchannelmixer=aa=0.85[l];[v][l]overlay=W-w-30:30' : '') + '[out]',
      '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', horiz]);
    if (fs.existsSync(horiz)) log(`✅ HORIZONTAL pronto → ${horiz}`);
  }
  if (SO_RAPIDO) {
    segs.forEach((s) => inUse.delete(s.file));
    return;
  }
  const src = path.join(dir, 'source.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ss', ss, '-t', dur,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', src]);
  segs.forEach((s) => inUse.delete(s.file));
  if (!fs.existsSync(src)) throw new Error('não consegui extrair o trecho');

  // versão completa: legenda palavra por palavra + split + logo (scripts da sua máquina)
  const bottom = [opt.bottom, cfg.bottom && path.resolve(HOME, cfg.bottom), path.join(HOME, 'bottom.mp4')].find((f) => f && fs.existsSync(f));
  fs.copyFileSync(bottom || src, path.join(dir, 'bottom.mp4'));
  const tr = await run(process.execPath, [path.join(SCRIPTS, 'transcribe.mjs'), src, dir], {cwd: path.dirname(SCRIPTS)});
  if (tr.code !== 0) throw new Error('transcrição do corte falhou: ' + tr.err.slice(-300));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const clipCfg = crop ? {crop, layout: 'live', topH: TOP_LIVE} : {focus};
  fs.writeFileSync(path.join(dir, 'cuts.json'), JSON.stringify({clips: [{id, start: 0, end: meta.duration, ...clipCfg, bottomStart: 0, ...(MARCA ? {} : {semMarca: true})}]}, null, 2));
  log(`🎬 Renderizando versão completa de ${id}…`);
  const b = await run(process.execPath, [path.join(SCRIPTS, 'build.mjs'), dir, OUT], {cwd: path.dirname(SCRIPTS)});
  if (b.code !== 0) throw new Error('render falhou: ' + b.err.slice(-300));
  beep();
  log(`✅ COMPLETO pronto em ${((Date.now() - t0) / 1000).toFixed(0)} s → ${path.join(OUT, id + '.mp4')}`);
}

// ---------------- versão RÁPIDA: câmera em cima, gameplay embaixo, degradê preto com legenda no meio ----------------
let assets = null;
async function prepAssets() {
  if (assets) return assets;
  const grad = path.join(WORK, 'degrade.png');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1080x360', '-frames:v', '1', '-vf',
    "format=rgba,geq=r=0:g=0:b=0:a='245*(0.5+0.5*cos(PI*abs(Y-180)/180))'", grad]);
  const src = path.join(HOME, cfg.logo || 'logo.png');
  let logo = null;
  if (fs.existsSync(src)) {
    logo = path.join(WORK, 'logo-redonda.png');
    await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf',
      "scale=110:110:force_original_aspect_ratio=increase,crop=110:110,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-55,Y-55),54),255,0)'", logo]);
    if (!fs.existsSync(logo)) logo = null;
  }
  assets = {grad, logo};
  return assets;
}

const assTime = (t) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
};
// legenda palavra por palavra (palavra falada em amarelo) a partir da transcrição ao vivo
function writeAss(file, c, durS, rel = null, hook = '') {
  const src = rel || words.filter((w) => w.t0 >= c.start - 0.1 && w.t0 < c.end).map((w) => ({text: w.text, t0: w.t0 - c.start, t1: Math.min(w.t1, c.end) - c.start}));
  const ws = src
    .filter((w) => !/[\[\]]/.test(w.text))
    .map((w) => ({...w, text: w.text.replace(/[.,;:!?…"]+$/g, '').replace(/^["'“”«(¿¡-]+/g, '').toUpperCase()}))
    .filter((w) => w.text);
  const pages = [];
  let cur = [];
  for (const w of ws) {
    const chars = cur.reduce((n, x) => n + x.text.length, 0) + w.text.length;
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
      lines.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Cap,,0,0,0,,{\\an5\\pos(540,${TOP_LIVE})}${txt}`);
    });
  });
  if (hook) {
    // gancho: título grande em cima da câmera nos primeiros 3 s, entrando com um "pop"
    const h = esc(hook).replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').trim().toUpperCase();
    lines.push(`Dialogue: 2,${assTime(0)},${assTime(Math.min(3.2, durS))},Gancho,,0,0,0,,{\\an8\\pos(540,70)\\fscx130\\fscy130\\t(0,180,\\fscx100\\fscy100)\\fad(0,250)}${h}`);
  }
  if (MARCA && cfg.profileName) lines.push(`Dialogue: 1,${assTime(0)},${assTime(durS + 1)},Nome,,0,0,0,,{\\an9\\pos(1040,158)}${esc(cfg.profileName)}`);
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial Black,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,9,4,5,40,40,0,1
Style: Gancho,Arial Black,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,8,5,8,60,60,0,1
Style: Nome,Arial Black,34,&H00FFFFFF,&H00FFFFFF,&H002A0014,&H00000000,1,0,0,0,100,100,0,0,1,5,0,9,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  fs.writeFileSync(file, head + lines.join('\n') + '\n');
  return ws.length;
}

// transcreve só o trecho do corte (usado quando a transcrição ao vivo pulou pedaços)
async function transcribeClip(wav) {
  const out = await transcribeSafe(wav, {prioridade: true});
  const {captions} = toCaptions({whisperCppOutput: out});
  const ws = captionsToWords(captions).map((w) => ({text: w.text, t0: w.startMs / 1000, t1: w.endMs / 1000}));
  return opt['manter-jogo'] ? ws : await soStreamer(wav, ws);
}

// tira da legenda as falas do JOGO (diálogos do GTA são em inglês; o streamer fala português):
// junta as palavras em frases e pede ao whisper para identificar o idioma de cada frase
async function soStreamer(wav, ws) {
  if (!ws.length) return ws;
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
  const lidModel = ['base', LIVE_MODEL, MODEL].map((m) => path.join(HOME, 'whisper.cpp', `ggml-${m}.bin`)).find((f) => fs.existsSync(f) && fs.statSync(f).size > 10e6);
  const fica = [];
  let tirou = 0;
  for (const f of frases) {
    const a = Math.max(0, f[0].t0 - 0.1);
    const d = Math.max(1, f[f.length - 1].t1 - a + 0.1);
    const chunk = wav.replace(/\.wav$/, `_frase.wav`);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', a.toFixed(2), '-t', d.toFixed(2), '-i', wav, '-c:a', 'pcm_s16le', chunk]);
    const r = await run(exe, ['-m', lidModel, '-f', chunk, '-l', 'auto', '-dl', '-t', String(threads())], {cwd: path.join(HOME, 'whisper.cpp')});
    fs.rmSync(chunk, {force: true});
    const lang = (r.out + r.err).match(/auto-detected language: (\w+)/)?.[1];
    if (lang && lang !== LANG) tirou += f.length;
    else fica.push(...f);
  }
  if (tirou) log(`   🎮 ${tirou} palavra(s) do jogo (outro idioma) fora da legenda`);
  return fica;
}

async function renderRapido({list, ss, dur, dir, out, c, segs}) {
  // câmera ainda desconhecida? procura agora, antes de montar
  if (!crop && claudeOk) {
    log('📷 Câmera ainda não conhecida — procurando antes de montar o corte…');
    camLast = 0;
    await findCamera(segs[segs.length - 1]);
  } else if (crop && claudeOk && Date.now() - camLast > 4 * 60000) {
    await findCamera(segs[segs.length - 1], true);
  }
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out];
  if (!crop) {
    log('⚠️  Câmera do streamer não encontrada — corte sai no layout simples. Rode com --crop x,y,w,h ou me peça para achar a câmera.');
    // sem câmera conhecida: vídeo inteiro no meio com fundo desfocado
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ss', ss, '-t', dur, '-filter_complex',
      '[0:v]fps=30,split[a][b];[a]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,boxblur=10:2,scale=1080:1920[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2',
      ...enc]);
    return;
  }
  const {grad, logo} = await prepAssets();
  const t0 = Date.now();
  // 1) trecho do corte num arquivo só (30 fps) + áudio 16 kHz
  const src = path.join(dir, 'src.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-ss', ss, '-t', dur, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-r', '30', '-c:a', 'aac', '-b:a', '192k', src]);
  const wav = path.join(dir, 'corte16k.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const D = Number(dur);

  // 2) palavras (transcrição ao vivo se tiver, senão transcreve o corte)
  let rel = null;
  for (let w = 0; AUTO && w < 12 && segs.some((x) => !x.transcribed) && (analyzing || analysisQueue.length); w++) await new Promise((r) => setTimeout(r, 1000));
  if (segs.some((x) => !x.transcribed)) {
    log('📝 Transcrevendo o corte…');
    try {
      rel = await transcribeClip(wav);
    } catch (e) {
      log('   transcrição do corte falhou:', e.message.slice(0, 120));
    }
  }
  if (!rel) rel = words.filter((w) => w.t0 >= c.start - 0.1 && w.t0 < c.end).map((w) => ({text: w.text, t0: w.t0 - c.start, t1: Math.min(w.t1, c.end) - c.start}));
  c.texto = rel.map((w) => w.text).join(' ');

  // 3) gancho = título do Claude (pede já, antes de montar)
  if (!c.titulo && claudeOk && c.texto && !opt['sem-gancho']) await getTitle(c);

  // 4) cortar pausas: tira silêncios > 0,45 s (deixa um respiro de 0,12 s)
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
  const relNew = rel.map((w) => ({...w, t0: remap(w.t0), t1: Math.max(remap(w.t0) + 0.1, remap(w.t1))}));

  // 5) zoom nos picos de volume (até 4, longe uns dos outros)
  let peaks = [];
  if (!opt['sem-zoom']) {
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
    const cand = pts.filter((p) => p.v > med + 8 && p.v > -26).sort((a, b) => b.v - a.v);
    for (const p of cand) {
      const tn = remap(p.t);
      if (peaks.every((q) => Math.abs(q - tn) > 4) && tn > 0.5) peaks.push(tn);
      if (peaks.length >= 4) break;
    }
  }
  const zExpr = peaks.length
    ? '1+0.18*' + peaks.map((pk) => `clip((it-${(pk - 0.15).toFixed(2)})/0.12,0,1)*clip((${(pk + 1.4).toFixed(2)}-it)/0.25,0,1)`).reduce((a, b) => `max(${a},${b})`)
    : '1';

  const nWords = writeAss(path.join(dir, 'legenda.ass'), c, newD, relNew, opt['sem-gancho'] ? '' : c.titulo);
  const sel = keep.map((k) => `between(t,${k.from.toFixed(3)},${k.to.toFixed(3)})`).join('+');
  const GAME = 1920 - TOP_LIVE;
  const build = (withSubs) => {
    let f = `[0:v]select='${sel}',setpts=N/30/TB,split=2[c][g];` +
      `[c]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=1620:${Math.round(TOP_LIVE * 1.5)}:force_original_aspect_ratio=increase,crop=1620:${Math.round(TOP_LIVE * 1.5)},` +
      `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x${TOP_LIVE}:fps=30[cam];` +
      `[g]scale=-2:${GAME},crop=1080:${GAME}[game];[cam][game]vstack[st];[st][1:v]overlay=0:${TOP_LIVE - 180}:shortest=1[v1];` +
      `[0:a]aselect='${sel}',asetpts=N/SR/TB[a]`;
    let last = 'v1';
    if (MARCA && logo) {
      f += `;[${last}][2:v]overlay=W-w-40:36[v2]`;
      last = 'v2';
    }
    if (withSubs) {
      f += `;[${last}]ass=legenda.ass[v3]`;
      last = 'v3';
    }
    return ['-y', '-v', 'error', '-i', src, '-loop', '1', '-i', grad, ...(MARCA && logo ? ['-loop', '1', '-i', logo] : []),
      '-filter_complex', f, '-map', `[${last}]`, '-map', '[a]', '-t', newD.toFixed(2), ...enc];
  };
  let r = await run('ffmpeg', build(true), {cwd: dir});
  if (r.code !== 0 || !fs.existsSync(out)) {
    log('Legenda no corte rápido falhou; tentando sem legenda.', r.err.slice(-200));
    r = await run('ffmpeg', build(false), {cwd: dir});
  }
  const cortou = D - newD;
  log(`   edição: ${cortou > 0.5 ? `-${cortou.toFixed(1)} s de pausas` : 'sem pausas'} | ${peaks.length} zoom(s)${c.titulo && !opt['sem-gancho'] ? ' | gancho' : ''} | ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (!nWords) log('   (corte rápido sem legenda: sem transcrição nesse trecho)');
}

// título + legenda do post pelo Claude, a partir da fala do corte
async function getTitle(c) {
  const prompt = `Você é o editor do canal de cortes ${cfg.profileName || ''} (GTA VI, TikTok e YouTube Shorts). Este é o que o streamer fala num corte de ${(c.end - c.start).toFixed(0)} s:
"${c.texto.slice(0, 2500)}"
Crie: 1) um GANCHO curto para aparecer escrito na tela no começo do vídeo (máx. 6 palavras, curiosidade/choque, PT-BR, pode ter 1 emoji no fim); 2) uma legenda de post com 3 hashtags.
Responda SÓ o JSON: {"titulo": "...", "legenda": "..."}`;
  const r = await Promise.race([run(CLAUDE, ['-p', '--output-format', 'text', '--model', CLAUDE_MODEL], {shell: IS_WIN, input: prompt}), new Promise((res) => setTimeout(() => res({out: ''}), 45000))]);
  try {
    const d = JSON.parse(r.out.match(/\{[\s\S]*\}/)?.[0]);
    c.titulo = d.titulo || '';
    c.legenda = d.legenda || '';
  } catch {}
}

// ---------------- limpeza do disco ----------------
function cleanup() {
  for (const s of segments) {
    if (s.abs0 + s.dur < total - KEEP && !inUse.has(s.file) && fs.existsSync(s.file)) fs.rmSync(s.file, {force: true});
  }
  for (const k of loud.keys()) if (k < total - KEEP - 60) loud.delete(k);
  while (words.length && words[0].t0 < total - KEEP - 60) words.shift();
}

// ---------------- corte manual pelo teclado ----------------
const rl = readline.createInterface({input: process.stdin});
rl.on('line', (line) => {
  const s = line.trim().toLowerCase();
  if (s === 'q' || s === 'sair') {
    stopping = true;
    log('Encerrando… (os cortes na fila terminam antes)');
    const wait = setInterval(() => {
      if (!clipping && !clipQueue.length) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 1000);
    return;
  }
  if (s !== '' && !/^\d+$/.test(s)) {
    log(`"${line.trim()}" não é um comando daqui. ENTER = corta 60 s | número + ENTER = corta esses segundos | q = sair.`);
    if (s.startsWith('--')) log('   Opções como --auto vão no comando de abrir o programa, não aqui dentro.');
    return;
  }
  const secs = Math.min(Number(s) || 60, 180);
  if (total < 5) return log('Ainda não gravou nada.');
  const c = {start: Math.max(0, total - secs), end: total, id: `manual-${hms(total).replace(/:/g, '')}`, titulo: '', legenda: '', motivo: 'corte manual'};
  log(`✂️  Cortando os últimos ${secs} s (até ${hms(total)})…`);
  clipQueue.push(c);
  pumpClips();
});

// ---------------- início ----------------
log(`MODO AO VIVO — ${nome}`);
log(`Cortes vão para: ${OUT}`);
log(`Transcrição ao vivo: ${transcriptFile}`);
if (!AUTO) log('MODO MANUAL: só corta quando você apertar ENTER (use --auto para a detecção automática).');
else log(`Detecção: ${twitch ? 'chat da Twitch + ' : kick ? 'chat da Kick + ' : ''}volume + fala | limiar ${limiar()} | Claude Code: ${claudeOk ? 'sim (' + CLAUDE_MODEL + ')' : 'não'}`);
log('ENTER = corta os últimos 60 s | "90" + ENTER = últimos 90 s | q + ENTER = sair');
process.on('SIGINT', () => process.exit(0));
await prepLiveModel();
startChat();
startKickChat();
startRecorder();
