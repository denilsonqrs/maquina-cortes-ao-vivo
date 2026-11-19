# Máquina de Cortes ao Vivo 🎬

Ferramenta para canais de cortes: **grava a live enquanto ela roda**, você aperta ENTER no momento bom e ela guarda o trecho na hora. Depois você escolhe a parte exata do clipe e ela **monta o vídeo vertical pronto para TikTok, Shorts e Reels**, com legenda, gancho e cortes dinâmicos.

Criada para o lançamento do GTA VI, quando quem posta o corte primeiro leva a exclusividade e esperar a live acabar para baixar não é uma opção.

## O que ela faz

**Durante a live (`ao-vivo.bat`)**
- Grava Twitch, Kick e YouTube em tempo real (pedaços de 10 s, só os últimos 40 min ficam em disco).
- Pula os anúncios da Twitch (com streamlink) e descarta trechos corrompidos.
- **ENTER** marca o momento e salva 40 s antes + 40 s depois como clipe bruto, para pegar o desfecho. Também dá para digitar os segundos de antes (`90` + ENTER).
- Espera sozinha se o streamer ainda não estiver ao vivo e começa a gravar quando a live abrir.
- Modo opcional `--auto`: detecta picos sozinha (chat da Twitch/Kick explodindo, grito, palavrão, "olha isso") e usa o Claude Code para decidir se vale o corte.

**Na edição (`editar.bat`)**
- Você escolhe o clipe bruto e o trecho (começo e fim).
- Layout vertical: **câmera do streamer em cima, gameplay embaixo**, degradê preto no meio com a legenda.
- **Legenda palavra por palavra**, com a palavra falada em amarelo e sincronizada com a fala (alinhamento DTW do whisper).
- **Só a fala do streamer**: os diálogos do jogo (em outro idioma) ficam fora da legenda.
- **Gancho** escrito na tela nos 3 primeiros segundos.
- **Pausas cortadas** e **zoom** na câmera nos picos de volume.
- A câmera do streamer é achada sozinha (pelo Claude Code) e fica salva por canal.
- Sai também um `.txt` com título e legenda para o post.

## Requisitos

- Windows 10/11
- [Node.js](https://nodejs.org) 18 ou mais novo
- ffmpeg, yt-dlp e streamlink (o `instalar.bat` instala pelo winget)
- [Claude Code](https://claude.com/claude-code), opcional: é ele que cria título e gancho, acha a câmera do streamer e decide os cortes no modo `--auto`. Sem ele tudo funciona, mas sem essas partes.

## Instalação

A máquina mora em `%USERPROFILE%\.maquina-cortes-gta`. No PowerShell:

```powershell
git clone https://github.com/denilsonqrs/maquina-cortes-ao-vivo "$env:USERPROFILE\.maquina-cortes-gta"
& "$env:USERPROFILE\.maquina-cortes-gta\instalar.bat"
```

Depois edite o `config.json` (criado a partir do `config.exemplo.json`) com o seu @ e, se quiser, coloque uma `logo.png` na pasta.

## Uso

**1. Durante a live**
```powershell
& "$env:USERPROFILE\.maquina-cortes-gta\ao-vivo.bat" https://www.twitch.tv/CANAL
```
- `ENTER` salva 40 s antes + 40 s depois do momento, `90` + `ENTER` salva 90 s antes, `q` + `ENTER` sai. Mude com `--antes N` e `--depois N`.
- Os brutos vão para `Vídeos\cortes-ao-vivo\<canal>\brutos`.
- Link do YouTube: coloque entre aspas e dê um nome, por exemplo `"https://www.youtube.com/watch?v=..." --nome canal`.

**2. Editar**
```powershell
& "$env:USERPROFILE\.maquina-cortes-gta\editar.bat"
```
Escolha o número do clipe, o começo (ex.: `0:12`) e o fim (ex.: `0:41`). O vídeo final sai em `Vídeos\cortes-ao-vivo\<canal>\...-EDITADO.mp4`.

### Opções úteis

| Onde | Opção | O que faz |
|---|---|---|
| ao-vivo | `--auto` | detecção automática de picos (pesa mais: transcreve a live inteira) |
| ao-vivo | `--crop x,y,w,h` | define na mão onde fica a câmera do streamer |
| ao-vivo | `--kick-sala N` | número da sala de chat da Kick, se a consulta automática for bloqueada |
| editar | `--gancho "TEXTO"` `--subgancho "TEXTO"` | escreve você mesmo o título e o subtítulo da tela |
| editar | `--corrigir "Errado=Certo"` | corrige uma palavra que o whisper errou |
| editar | `--sem-gancho` `--sem-cortar-pausas` `--sem-zoom` | desliga cada edição |
| editar | `--manter-jogo` | mantém as falas do jogo na legenda |

## Como funciona por dentro

- **Gravação:** `yt-dlp`/`streamlink` → `ffmpeg` em segmentos `.ts` de 10 s.
- **Transcrição:** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) local (modelo `base` ao vivo, `small` na edição), usando o tempo do alinhamento DTW de cada palavra para a legenda acompanhar a fala.
- **Filtro de idioma:** cada frase passa pela detecção de idioma do whisper, e o que não é português sai da legenda.
- **Edição:** `ffmpeg` (select/aselect para cortar pausas, zoompan para o zoom, libass para a legenda).
- **Versão completa opcional** (`--completo`): render em [Remotion](https://www.remotion.dev).

## Licenças e avisos

- Código sob licença MIT (veja `LICENSE`).
- whisper.cpp e os modelos Whisper são MIT.
- **Remotion** é gratuito para pessoas físicas e empresas pequenas, mas empresas maiores precisam de licença paga. Veja [remotion.dev/license](https://www.remotion.dev/license).
- Esta ferramenta grava transmissões de terceiros. **O uso é de responsabilidade de quem usa**: respeite os termos de uso da Twitch, Kick e YouTube e os direitos dos criadores de conteúdo.

## Créditos

Desenvolvido por [denilsonqrs](https://github.com/denilsonqrs), com a ajuda do [Claude](https://claude.ai) (Anthropic).

## Fontes

A legenda e o título usam a fonte [Montserrat](https://github.com/JulietaUla/Montserrat) (SIL Open Font License, em `engine/fonts/OFL.txt`).
