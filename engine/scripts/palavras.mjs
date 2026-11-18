// Junta os tokens do whisper.cpp em palavras com o tempo CERTO de cada uma.
// Usa o tempo do alinhamento DTW (timestampMs / t_dtw), que acompanha a fala; os "offsets" do whisper
// esticam e espremem as frases e deixam a legenda fora de sincronia.
export function captionsToWords(captions) {
  const words = [];
  for (const c of captions) {
    const raw = c.text;
    const t = raw.trim();
    if (!t) continue;
    if (/^\[_/.test(t)) continue; // [_BEG_], [_TT_...]
    const at = c.timestampMs ?? c.startMs;
    const startsWord = /^\s/.test(raw) || words.length === 0;
    if (startsWord) words.push({text: t, startMs: at, endMs: at, rawEnd: c.endMs});
    else {
      const w = words[words.length - 1];
      w.text += t;
      w.rawEnd = c.endMs;
    }
  }
  // tira [música], [vinheta] etc. (podem vir quebrados em vários tokens)
  const clean = words.filter((w) => !/[\[\]]/.test(w.text) && !/^[(*]/.test(w.text));
  // garante ordem crescente e define o fim de cada palavra pelo começo da próxima
  for (let i = 1; i < clean.length; i++) clean[i].startMs = Math.max(clean[i].startMs, clean[i - 1].startMs + 40);
  clean.forEach((w, i) => {
    const next = clean[i + 1];
    const natural = Math.max(250, Math.min(1200, (w.rawEnd ?? w.startMs) - w.startMs));
    w.endMs = next ? Math.min(next.startMs - 20, w.startMs + 1500) : w.startMs + Math.min(natural, 900);
    if (w.endMs < w.startMs + 80) w.endMs = w.startMs + 80;
    delete w.rawEnd;
  });
  return clean;
}
