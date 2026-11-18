import React from 'react';
import {registerRoot, Composition, AbsoluteFill, Img, staticFile} from 'remotion';

// Posições de cada formato: 916 = 1080x1920 (Shorts/Reels), 34 = 1080x1440 (grade do TikTok)
const L = {
  916: {H: 1920, bgH: 1100, blurTop: 820, fadeTop: 650, top: 135, topFs: 104, big: 245, bigMax: 210, faceTop: 660, faceW: 900, faceH: 800, arrowTop: 1180, tagTop: 1250, bottom: 1490, botFs: 118, gta: 1770},
  34: {H: 1440, bgH: 760, blurTop: 560, fadeTop: 420, top: 100, topFs: 92, big: 195, bigMax: 180, faceTop: 425, faceW: 820, faceH: 600, arrowTop: 790, tagTop: 850, bottom: 1075, botFs: 100, gta: 1325},
};

const T = ({bg, face, logo, perfil, top, big, bottom, tag, cor = '#FFD400', fmt = '916'}) => {
  const l = L[fmt];
  const txt = {position: 'absolute', left: 40, right: 40, textAlign: 'center', textTransform: 'uppercase', color: '#fff',
    WebkitTextStroke: '12px #000', paintOrder: 'stroke fill', textShadow: '0 10px 0 rgba(0,0,0,.6)', lineHeight: 0.95,
    fontFamily: 'Impact, "Arial Black", sans-serif'};
  return (
    <AbsoluteFill style={{background: '#000', overflow: 'hidden'}}>
      <Img src={staticFile(bg)} style={{position: 'absolute', left: 0, top: l.blurTop, width: 1080, height: l.H - l.blurTop + 100, objectFit: 'cover', filter: 'blur(18px) brightness(.45)', transform: 'scale(1.1)'}} />
      <Img src={staticFile(bg)} style={{position: 'absolute', left: 0, top: 0, width: 1080, height: l.bgH, objectFit: 'cover'}} />
      <div style={{position: 'absolute', left: 0, right: 0, top: l.fadeTop, height: l.bgH - l.fadeTop + 60, background: 'linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.9))'}} />
      <div style={{...txt, top: l.top, fontSize: l.topFs}}>{top}</div>
      <div style={{...txt, top: l.big, fontSize: Math.min(l.bigMax, Math.floor(1900 / big.length)), color: cor, letterSpacing: 2}}>{big}</div>
      <div style={{position: 'absolute', left: (1080 - l.faceW) / 2, top: l.faceTop, width: l.faceW, height: l.faceH, transform: 'rotate(-2deg)', border: `14px solid ${cor}`, borderRadius: 36,
        boxShadow: `0 0 0 10px #000, 0 30px 80px rgba(0,0,0,.8), 0 0 120px ${cor}88`, overflow: 'hidden'}}>
        <Img src={staticFile(face)} style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 35%'}} />
      </div>
      <svg viewBox="0 0 200 120" style={{position: 'absolute', left: 10, top: l.arrowTop, width: 250, transform: 'rotate(-35deg)', filter: 'drop-shadow(0 8px 0 #000)'}}>
        <path d="M0 45h120V5l80 55-80 55V75H0z" fill="#E1002D" stroke="#fff" strokeWidth="8" strokeLinejoin="round" />
      </svg>
      <div style={{position: 'absolute', right: 40, top: l.tagTop, fontSize: 190, transform: 'rotate(12deg)', fontFamily: '"Segoe UI Emoji"', filter: 'drop-shadow(0 10px 10px rgba(0,0,0,.7))'}}>{tag}</div>
      <div style={{...txt, top: l.bottom, fontSize: l.botFs}} dangerouslySetInnerHTML={{__html: bottom.replace(/\*(.+?)\*/g, `<span style="color:${cor}">$1</span>`)}} />
      <div style={{position: 'absolute', left: '50%', top: l.gta, transform: 'translateX(-50%) rotate(-3deg)', background: '#E1002D', color: '#fff', fontSize: fmt === '34' ? 64 : 80,
        padding: '6px 40px', border: '8px solid #000', borderRadius: 18, fontFamily: 'Impact'}}>GTA 6</div>
      {logo ? (
        <div style={{position: 'absolute', right: 30, top: 24, display: 'flex', alignItems: 'center', gap: 10, fontFamily: '"Arial Black"', fontSize: 30, color: '#fff', WebkitTextStroke: '6px #14002a', paintOrder: 'stroke fill'}}>
          <Img src={staticFile(logo)} style={{width: 66, height: 66, borderRadius: '50%', border: '3px solid #fff'}} />
          {perfil}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const defaults = {bg: 'bg.jpg', face: 'face.png', logo: '', perfil: '', top: '', big: '', bottom: '', tag: '😱'};

registerRoot(() => (
  <>
    <Composition id="Thumb" component={T} width={1080} height={1920} fps={30} durationInFrames={1} defaultProps={{...defaults, fmt: '916'}} />
    <Composition id="Thumb34" component={T} width={1080} height={1440} fps={30} durationInFrames={1} defaultProps={{...defaults, fmt: '34'}} />
  </>
));
