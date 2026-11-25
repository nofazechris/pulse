import type { Env } from '../../config/env';
import { AppError } from '../../utils/errors';

/** PCM from the Even SDK: 16 kHz, signed 16-bit little-endian, mono. */
export interface AudioInput {
  pcm: Buffer;
  sampleRate: 16000;
}
export interface TranscriptionResult {
  text: string;
}
export interface SpeechRecognitionProvider {
  readonly name: string;
  isAvailable(): boolean;
  transcribe(audio: AudioInput): Promise<TranscriptionResult>;
}

/** Wraps raw PCM in a RIFF/WAVE header so standard transcription APIs accept it. */
export function pcmToWav(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class UnavailableSttProvider implements SpeechRecognitionProvider {
  readonly name = 'none';
  isAvailable(): boolean {
    return false;
  }
  async transcribe(): Promise<TranscriptionResult> {
    throw new AppError(501, 'STT_UNAVAILABLE', 'Speech recognition is not configured. Type your request instead.');
  }
}

/** Whisper-compatible `/audio/transcriptions` endpoint (OpenAI or any compatible server). */
export class WhisperCompatibleProvider implements SpeechRecognitionProvider {
  readonly name = 'openai';
  constructor(private readonly key: string, private readonly baseUrl: string, private readonly model = 'whisper-1') {}
  isAvailable(): boolean {
    return true;
  }
  async transcribe(audio: AudioInput): Promise<TranscriptionResult> {
    const form = new FormData();
    form.set('model', this.model);
    form.set('language', 'en');
    form.set('file', new Blob([new Uint8Array(pcmToWav(audio.pcm, audio.sampleRate))], { type: 'audio/wav' }), 'speech.wav');
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST', headers: { authorization: `Bearer ${this.key}` }, body: form, signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppError(502, 'STT_FAILED', 'Speech recognition is unavailable right now.');
    }
    if (!res.ok) throw new AppError(502, 'STT_FAILED', 'Speech recognition failed.');
    const body = (await res.json()) as { text?: string };
    const text = (body.text ?? '').trim();
    if (!text) throw new AppError(422, 'STT_EMPTY', 'I did not catch that.');
    return { text: text.slice(0, 500) };
  }
}

export function createSttProvider(env: Pick<Env, 'STT_PROVIDER' | 'STT_API_KEY' | 'STT_BASE_URL'>): SpeechRecognitionProvider {
  if (env.STT_PROVIDER === 'openai' && env.STT_API_KEY) {
    return new WhisperCompatibleProvider(env.STT_API_KEY, env.STT_BASE_URL ?? 'https://api.openai.com/v1');
  }
  return new UnavailableSttProvider();
}
