// Instala o whisper.cpp (1.5.5) e baixa os modelos "small" (legenda caprichada) e "base" (rápido, usado ao vivo)
// em %USERPROFILE%\.maquina-cortes-gta\whisper.cpp
import os from 'node:os';
import path from 'node:path';
import {installWhisperCpp, downloadWhisperModel} from '@remotion/install-whisper-cpp';

const to = path.join(os.homedir(), '.maquina-cortes-gta', 'whisper.cpp');
await installWhisperCpp({to, version: '1.5.5'});
for (const model of ['small', 'base']) await downloadWhisperModel({model, folder: to});
console.log('whisper.cpp e modelos prontos em', to);
