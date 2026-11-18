import fs from 'node:fs';
import path from 'node:path';

// Chrome is started with fake camera/microphone devices so Meet never asks for real ones.
// We feed them a silent WAV and a plain dark frame, so even if muting failed the bot would
// send silence and a blank picture, never your real mic/camera.
export function ensureFakeMedia(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, 'silence.wav');
  const y4m = path.join(dir, 'blank.y4m');

  if (!fs.existsSync(wav)) {
    const sampleRate = 48000;
    const dataSize = sampleRate * 2; // 1 s, mono, 16-bit
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    fs.writeFileSync(wav, buf);
  }

  if (!fs.existsSync(y4m)) {
    const w = 640;
    const h = 360;
    const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`);
    const frame = Buffer.concat([
      Buffer.from('FRAME\n'),
      Buffer.alloc(w * h, 40), // dark grey luma
      Buffer.alloc((w / 2) * (h / 2) * 2, 128), // neutral chroma
    ]);
    fs.writeFileSync(y4m, Buffer.concat([header, frame, frame]));
  }
  return { wav, y4m };
}
