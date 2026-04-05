import { app, BrowserWindow, dialog, ipcMain, WebContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
const ffprobeStatic = require('ffprobe-static');

ffmpeg.setFfmpegPath(ffmpegPath as string);
ffmpeg.setFfprobePath(ffprobeStatic.path);

type SlideInput = {
  path: string;
  durationSeconds?: number;
};

type CaptionsConfig = {
  enabled?: boolean;
  mode?: 'none' | 'importSrt' | 'whisperCpp';
  srtPath?: string;
  whisperExecutablePath?: string;
  whisperModelPath?: string;
  fontSize?: number;
  marginV?: number;
};

type ExportPayload = {
  audioPath: string;
  slides: SlideInput[];
  outputPath?: string;
  resolution: '1280x720' | '1920x1080';
  fps: number;
  captions?: CaptionsConfig;
};

type TranscriptPayload = {
  audioPath: string;
  captions: CaptionsConfig;
};

type TranscriptionProgressPayload = {
  stage: string;
  percent: number | null;
  label: string;
};

type ProgressSend = (payload: TranscriptionProgressPayload) => void;

function createThrottledProgressSender(sender: WebContents): ProgressSend {
  let lastSent = 0;
  let lastPercent: number | null = null;
  return (payload: TranscriptionProgressPayload) => {
    if (sender.isDestroyed()) return;
    const now = Date.now();
    const p = payload.percent;
    if (p != null && p > 0 && p < 100) {
      if (now - lastSent < 120 && lastPercent != null && Math.abs(p - lastPercent) < 1) return;
      lastSent = now;
      lastPercent = p;
    }
    sender.send('transcription-progress', payload);
  };
}

function whisperTimestampToSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/** Overall job percent (10–99) from whisper.cpp stderr/stdout tail, or null if unknown. */
function parseWhisperLogForOverallPercent(logTail: string, totalSec: number): number | null {
  const segRegex = /\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/g;
  let m: RegExpExecArray | null;
  let lastEndSec = 0;
  while ((m = segRegex.exec(logTail)) !== null) {
    lastEndSec = whisperTimestampToSeconds(m[5], m[6], m[7], m[8]);
  }
  if (totalSec > 0 && lastEndSec > 0) {
    const rel = Math.min(1, lastEndSec / totalSec);
    return 10 + rel * 90;
  }
  const pctMatches = logTail.match(/\b(\d{1,3}(?:\.\d+)?)\s*%/g);
  if (pctMatches?.length) {
    const last = parseFloat(pctMatches[pctMatches.length - 1]);
    if (!Number.isNaN(last)) {
      const rel = Math.min(100, Math.max(0, last)) / 100;
      return 10 + rel * 90;
    }
  }
  return null;
}

function mapFfmpegPercentToOverall(n: number): number {
  return Math.min(10, Math.max(0, (n / 100) * 10));
}

/** Parse ffmpeg timemark like 00:01:23.45 or 01:23.45 to seconds. */
function parseFfmpegTimemarkToSeconds(mark: string): number | null {
  const s = mark.trim();
  const re3 = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
  const re2 = /^(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/;
  let m = s.match(re3);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    const sec = Number(m[3]);
    const frac = m[4] ? Number(`0.${m[4]}`) : 0;
    return h * 3600 + min * 60 + sec + frac;
  }
  m = s.match(re2);
  if (m) {
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const frac = m[3] ? Number(`0.${m[3]}`) : 0;
    return min * 60 + sec + frac;
  }
  return null;
}

function progressFromFfmpegEvent(
  progress: { percent?: string | number; timemark?: string },
  durationHintSeconds: number
): number | null {
  if (progress.percent != null && String(progress.percent) !== 'N/A') {
    const n = Number(progress.percent);
    if (!Number.isNaN(n)) return Math.min(100, Math.max(0, n));
  }
  if (durationHintSeconds > 0 && progress.timemark) {
    const t = parseFfmpegTimemarkToSeconds(progress.timemark);
    if (t != null && t >= 0) return Math.min(100, (t / durationHintSeconds) * 100);
  }
  return null;
}

type ExportProgressProfile = 'none' | 'importSrt' | 'whisper';

function getExportProgressRanges(profile: ExportProgressProfile): {
  slideFrom: number;
  slideTo: number;
  transcriptFrom: number;
  transcriptTo: number;
  muxFrom: number;
  muxTo: number;
} {
  switch (profile) {
    case 'importSrt':
      return { slideFrom: 0, slideTo: 76, transcriptFrom: 76, transcriptTo: 80, muxFrom: 80, muxTo: 100 };
    case 'whisper':
      return { slideFrom: 0, slideTo: 28, transcriptFrom: 28, transcriptTo: 82, muxFrom: 82, muxTo: 100 };
    default:
      return { slideFrom: 0, slideTo: 88, transcriptFrom: 88, transcriptTo: 88, muxFrom: 88, muxTo: 100 };
  }
}

let mainWindow: BrowserWindow | null = null;

/**
 * Default save folders: ./output/... next to the project when running from source.
 * Packaged builds use userData/output (install dir is often read-only).
 */
function ensureOutputSubdir(...parts: string[]): string {
  const base = app.isPackaged
    ? path.join(app.getPath('userData'), 'output')
    : path.join(app.getAppPath(), 'output');
  const dir = path.join(base, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRendererHtmlPath() {
  const builtPath = path.join(__dirname, 'renderer.html');
  if (fs.existsSync(builtPath)) {
    return builtPath;
  }
  return path.resolve(__dirname, '../src/renderer.html');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 980,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(getRendererHtmlPath());
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format.duration ?? 0;
      resolve(duration);
    });
  });
}

function escapeForFfmpegConcat(inputPath: string): string {
  return inputPath.replace(/'/g, "'\\''");
}

function normalizeForSubtitleFilter(inputPath: string): string {
  return path
    .resolve(inputPath)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/ /g, '\\ ')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function srtTimestampToSeconds(timestamp: string): number {
  const match = timestamp.trim().match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!match) return 0;
  const [, hh, mm, ss, ms] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

function secondsToVttTimestamp(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
  return [hours, minutes, seconds].map(v => String(v).padStart(2, '0')).join(':') + '.' + String(milliseconds).padStart(3, '0');
}

function parseSrtBlocks(srtContent: string): Array<{ start: number; end: number; text: string }> {
  const blocks = srtContent
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/)
    .map(block => block.trim())
    .filter(Boolean);

  return blocks.map(block => {
    const lines = block.split('\n').map(line => line.trimEnd());
    const timeLine = lines.find(line => line.includes('-->')) || '';
    const [startRaw = '00:00:00,000', endRaw = '00:00:00,000'] = timeLine.split('-->').map(part => part.trim());
    const timeLineIndex = lines.findIndex(line => line === timeLine);
    const textLines = lines.slice(Math.max(timeLineIndex + 1, 0)).filter(line => line && !/^\d+$/.test(line.trim()));

    return {
      start: srtTimestampToSeconds(startRaw),
      end: srtTimestampToSeconds(endRaw),
      text: textLines.join('\n').trim()
    };
  }).filter(item => item.text);
}

function srtToPlainText(srtContent: string): string {
  return parseSrtBlocks(srtContent)
    .map(block => block.text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function srtToVtt(srtContent: string): string {
  const blocks = parseSrtBlocks(srtContent);
  const vttBlocks = blocks.map((block, index) => {
    return `${index + 1}\n${secondsToVttTimestamp(block.start)} --> ${secondsToVttTimestamp(block.end)}\n${block.text}`;
  });
  return `WEBVTT\n\n${vttBlocks.join('\n\n')}\n`;
}

function secondsToAssTimestamp(totalSeconds: number): string {
  let sec = Math.max(0, totalSeconds);
  const h = Math.floor(sec / 3600);
  sec -= h * 3600;
  const m = Math.floor(sec / 60);
  sec -= m * 60;
  const whole = Math.floor(sec);
  const centis = Math.round((sec - whole) * 100);
  const c = centis >= 100 ? 99 : centis;
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function escapeAssDialogueText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\n/g, '\\N')
    .trim();
}

/** ASS with explicit PlayRes + Style so alignment/outline do not depend on ffmpeg force_style. */
function buildBurnInAssFromSrt(
  srtContent: string,
  playResX: number,
  playResY: number,
  fontName: string,
  fontSize: number,
  marginV: number
): string {
  const blocks = parseSrtBlocks(srtContent);
  const styleLine =
    `Style: Default,${fontName},${fontSize},` +
    `&H00FFFFFF,&H000000FF,&H00000000,&H40000000,` +
    `0,0,0,0,100,100,0,0,` +
    `1,3,0,8,0,0,${marginV},1`;

  const header =
    `[Script Info]\n` +
    `Title: burn\n` +
    `ScriptType: v4.00+\n` +
    `WrapStyle: 0\n` +
    `ScaledBorderAndShadow: yes\n` +
    `PlayResX: ${playResX}\n` +
    `PlayResY: ${playResY}\n` +
    `\n` +
    `[V4+ Styles]\n` +
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
    `${styleLine}\n` +
    `\n` +
    `[Events]\n` +
    `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  const dialogues = blocks.map((block) => {
    const start = secondsToAssTimestamp(block.start);
    const end = secondsToAssTimestamp(Math.max(block.end, block.start + 0.05));
    const body = escapeAssDialogueText(block.text);
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${body}`;
  });

  return header + dialogues.join('\n') + '\n';
}

async function buildSlidesVideo(
  slides: SlideInput[],
  targetVideoPath: string,
  resolution: string,
  fps: number,
  targetDuration: number,
  onProgress?: (localPercent: number | null) => void
): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slides-video-'));
  const concatFilePath = path.join(tempDir, 'slides.txt');

  const totalSpecified = slides.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
  const unspecifiedCount = slides.filter(s => !s.durationSeconds || s.durationSeconds <= 0).length;
  const remaining = Math.max(targetDuration - totalSpecified, 0);
  const autoDuration = unspecifiedCount > 0 ? remaining / unspecifiedCount : 0;

  const normalized = slides.map((slide) => ({
    path: slide.path,
    duration: (slide.durationSeconds && slide.durationSeconds > 0) ? slide.durationSeconds : autoDuration
  })).filter(s => s.duration > 0);

  if (normalized.length === 0) {
    throw new Error('No valid slide durations could be calculated.');
  }

  const concatLines: string[] = [];
  normalized.forEach((slide, idx) => {
    concatLines.push(`file '${escapeForFfmpegConcat(path.resolve(slide.path))}'`);
    concatLines.push(`duration ${slide.duration.toFixed(3)}`);
    if (idx === normalized.length - 1) {
      concatLines.push(`file '${escapeForFfmpegConcat(path.resolve(slide.path))}'`);
    }
  });

  fs.writeFileSync(concatFilePath, concatLines.join('\n'), 'utf8');

  const [outW, outH] = resolution.split('x').map((n) => Number(n));
  if (!outW || !outH) {
    throw new Error(`Invalid resolution "${resolution}"; expected WIDTHxHEIGHT (e.g. 1920x1080).`);
  }

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg()
      .input(concatFilePath)
      .inputOptions(['-safe 0', '-f concat'])
      .outputOptions([
        '-y',
        `-vf scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
        `-r ${fps}`,
        '-pix_fmt yuv420p',
        '-c:v libx264'
      ])
      .save(targetVideoPath);

    if (onProgress) {
      cmd.on('progress', progress => {
        const p = progressFromFfmpegEvent(progress, targetDuration);
        onProgress(p);
      });
    }

    cmd
      .on('end', () => {
        onProgress?.(100);
        resolve();
      })
      .on('error', (err) => reject(err));
  });
}

async function createWavForTranscription(audioPath: string, wavPath: string, onProgress?: (percent: number) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(audioPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .format('wav')
      .outputOptions('-y')
      .save(wavPath)
      .on('end', () => resolve())
      .on('error', reject);

    if (onProgress) {
      cmd.on('progress', progress => {
        if (progress.percent != null) {
          onProgress(Number(progress.percent));
        }
      });
    }
  });
}

async function runWhisperCppTranscription(
  audioPath: string,
  whisperExecutablePath: string,
  whisperModelPath: string,
  workingDir: string,
  send?: ProgressSend
): Promise<string> {
  if (!fs.existsSync(whisperExecutablePath)) {
    throw new Error('whisper.cpp executable not found.');
  }
  if (!fs.existsSync(whisperModelPath)) {
    throw new Error('whisper.cpp model file not found.');
  }

  const wavPath = path.join(workingDir, 'transcription-input.wav');
  const outputBase = path.join(workingDir, `transcript-${Date.now()}`);
  const srtPath = `${outputBase}.srt`;

  let totalSec = 0;
  try {
    totalSec = await getAudioDuration(audioPath);
  } catch {
    /* ignore */
  }

  send?.({ stage: 'ffmpeg', percent: null, label: 'Converting audio to 16 kHz WAV…' });

  await createWavForTranscription(audioPath, wavPath, ffmpegPct => {
    send?.({
      stage: 'ffmpeg',
      percent: mapFfmpegPercentToOverall(ffmpegPct),
      label: `Converting audio… ${Math.round(ffmpegPct)}%`
    });
  });

  send?.({ stage: 'whisper', percent: null, label: 'Running whisper.cpp…' });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(whisperExecutablePath, ['-m', whisperModelPath, '-f', wavPath, '-osrt', '-of', outputBase], {
      cwd: path.dirname(whisperExecutablePath),
      windowsHide: true
    });

    let combinedLog = '';
    const appendLog = (chunk: Buffer | string) => {
      combinedLog += String(chunk);
      if (combinedLog.length > 65536) {
        combinedLog = combinedLog.slice(-65536);
      }
      if (!send) return;
      const overall = parseWhisperLogForOverallPercent(combinedLog, totalSec);
      if (overall != null) {
        const throughAudioPct = totalSec > 0 ? Math.min(99, Math.round(((overall - 10) / 90) * 100)) : null;
        send({
          stage: 'whisper',
          percent: overall,
          label:
            throughAudioPct != null
              ? `Transcribing… ~${throughAudioPct}% of audio processed`
              : `Transcribing… ~${Math.round(overall)}%`
        });
      }
    };

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      appendLog(chunk);
    });
    child.stdout.on('data', chunk => {
      appendLog(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `whisper.cpp exited with code ${code}.`));
        return;
      }
      resolve();
    });
  });

  if (!fs.existsSync(srtPath)) {
    throw new Error('Transcription finished, but no SRT file was generated.');
  }

  send?.({ stage: 'whisper', percent: 100, label: 'Transcription complete.' });
  return srtPath;
}

async function resolveSrtFromCaptions(
  audioPath: string,
  captions?: CaptionsConfig,
  workingDir?: string,
  send?: ProgressSend
): Promise<string | undefined> {
  if (!captions?.enabled) return undefined;

  if (captions.mode === 'importSrt') {
    if (!captions.srtPath) {
      throw new Error('Captions are enabled, but no SRT file was selected.');
    }
    send?.({ stage: 'load', percent: null, label: 'Loading SRT…' });
    send?.({ stage: 'load', percent: 100, label: 'Subtitles loaded.' });
    return captions.srtPath;
  }

  if (captions.mode === 'whisperCpp') {
    if (!captions.whisperExecutablePath || !captions.whisperModelPath) {
      throw new Error('Captions are enabled, but whisper.cpp executable or model path is missing.');
    }
    const targetDir = workingDir || fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
    return runWhisperCppTranscription(audioPath, captions.whisperExecutablePath, captions.whisperModelPath, targetDir, send);
  }

  return undefined;
}

async function muxAudioAndVideo(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  durationHintSeconds: number,
  onProgress?: (localPercent: number | null) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-y',
        '-c:v copy',
        '-c:a aac',
        '-b:a 192k',
        '-shortest'
      ])
      .save(outputPath);

    if (onProgress) {
      cmd.on('progress', progress => {
        onProgress(progressFromFfmpegEvent(progress, durationHintSeconds));
      });
    }

    cmd
      .on('end', () => {
        onProgress?.(100);
        resolve();
      })
      .on('error', (err) => reject(err));
  });
}

async function muxAudioVideoAndBurnSubtitles(
  videoPath: string,
  audioPath: string,
  srtPath: string,
  outputPath: string,
  fps: number,
  resolution: string,
  captions: CaptionsConfig | undefined,
  durationHintSeconds: number,
  onProgress?: (localPercent: number | null) => void
): Promise<void> {
  const [outW, outH] = resolution.split('x').map((n) => Number(n));
  if (!outW || !outH) {
    throw new Error(`Invalid resolution "${resolution}" for subtitle burn.`);
  }

  const bandRatio = 0.12;
  const topBand = Math.max(56, Math.round(outH * bandRatio));
  const bottomBand = topBand;
  const contentH = outH - topBand - bottomBand;

  const userFontSize = Math.max(16, Number(captions?.fontSize ?? 28));
  const refH = 720;
  const scaled = Math.round(userFontSize * (outH / refH));
  const burnFontSize = Math.max(22, Math.min(scaled, Math.floor(outH * 0.15)));
  const marginV = Math.max(10, Number(captions?.marginV ?? 26));
  const marginFromTop = Math.max(
    4,
    Math.min(marginV, Math.floor(topBand * 0.22), topBand - burnFontSize - 6)
  );

  const srtContent = fs.readFileSync(srtPath, 'utf8');
  const assPath = path.join(path.dirname(srtPath), 'burn-subtitles.ass');
  const assBody = buildBurnInAssFromSrt(srtContent, outW, outH, 'Arial', burnFontSize, marginFromTop);
  fs.writeFileSync(assPath, assBody, 'utf8');
  const subtitlePath = normalizeForSubtitleFilter(assPath);

  const layoutChain =
    `scale=w=${outW}:h=${contentH}:force_original_aspect_ratio=decrease,` +
    `pad=${outW}:${contentH}:(ow-iw)/2:(oh-ih)/2,` +
    `pad=${outW}:${outH}:0:${topBand}`;

  const vf = `${layoutChain},subtitles='${subtitlePath}'`;

  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-y',
        '-vf',
        vf,
        '-r',
        String(fps),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest'
      ])
      .save(outputPath);

    if (onProgress) {
      cmd.on('progress', progress => {
        onProgress(progressFromFfmpegEvent(progress, durationHintSeconds));
      });
    }

    cmd
      .on('end', () => {
        onProgress?.(100);
        resolve();
      })
      .on('error', (err) => reject(err));
  });
}

function safeFileBase(name: string): string {
  const trimmed = name.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim();
  const s = trimmed.length > 0 ? trimmed : 'output';
  return s.length > 120 ? s.slice(0, 120) : s;
}

async function runExportCore(
  payload: ExportPayload,
  outputPath: string,
  send: ProgressSend,
  options?: { existingSrtPath?: string }
): Promise<{ outputPath: string; captionsApplied: boolean; srtPath: string | null }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-to-mp4-'));
  const tempVideoOnlyPath = path.join(tempDir, 'slides-only.mp4');

  const exportProfile: ExportProgressProfile = !payload.captions?.enabled
    ? 'none'
    : payload.captions.mode === 'whisperCpp'
      ? 'whisper'
      : 'importSrt';
  const pr = getExportProgressRanges(exportProfile);

  const mapTranscriptProgress: ProgressSend = (p) => {
    if (p.percent == null) {
      send({ ...p, percent: null });
      return;
    }
    const span = pr.transcriptTo - pr.transcriptFrom;
    send({ ...p, percent: pr.transcriptFrom + (p.percent / 100) * span });
  };

  send({ stage: 'export', percent: null, label: 'Preparing export…' });
  const audioDuration = await getAudioDuration(payload.audioPath);

  await buildSlidesVideo(
    payload.slides,
    tempVideoOnlyPath,
    payload.resolution,
    payload.fps,
    audioDuration,
    (local) => {
      if (local == null) {
        send({ stage: 'slides', percent: null, label: 'Encoding slides from images…' });
        return;
      }
      const slideSpan = pr.slideTo - pr.slideFrom;
      send({
        stage: 'slides',
        percent: pr.slideFrom + (local / 100) * slideSpan,
        label: local >= 99 ? 'Finishing slide video…' : `Encoding slides… ${Math.round(local)}%`
      });
    }
  );

  send({ stage: 'slides', percent: pr.slideTo, label: 'Slide video ready.' });

  let resolvedSrtPath: string | undefined;
  if (options?.existingSrtPath) {
    resolvedSrtPath = options.existingSrtPath;
  } else {
    resolvedSrtPath = await resolveSrtFromCaptions(
      payload.audioPath,
      payload.captions,
      tempDir,
      exportProfile === 'none' ? undefined : mapTranscriptProgress
    );
  }

  const muxSpan = pr.muxTo - pr.muxFrom;
  if (resolvedSrtPath) {
    const burnSrtPath = path.join(tempDir, 'burn-subtitles.srt');
    fs.copyFileSync(resolvedSrtPath, burnSrtPath);

    await muxAudioVideoAndBurnSubtitles(
      tempVideoOnlyPath,
      payload.audioPath,
      burnSrtPath,
      outputPath,
      payload.fps,
      payload.resolution,
      payload.captions,
      audioDuration,
      (local) => {
        if (local == null) {
          send({ stage: 'mux', percent: null, label: 'Muxing and burning subtitles…' });
          return;
        }
        send({
          stage: 'mux',
          percent: pr.muxFrom + (local / 100) * muxSpan,
          label: `Final encode… ${Math.round(local)}%`
        });
      }
    );
  } else {
    await muxAudioAndVideo(
      tempVideoOnlyPath,
      payload.audioPath,
      outputPath,
      audioDuration,
      (local) => {
        if (local == null) {
          send({ stage: 'mux', percent: null, label: 'Muxing audio and video (-c:v copy)…' });
          return;
        }
        send({
          stage: 'mux',
          percent: pr.muxFrom + (local / 100) * muxSpan,
          label: `Muxing… ${Math.round(local)}%`
        });
      }
    );
  }

  send({ stage: 'export', percent: 100, label: 'Export complete.' });

  return {
    outputPath,
    captionsApplied: Boolean(resolvedSrtPath),
    srtPath: resolvedSrtPath ?? null
  };
}

ipcMain.handle('pick-audio', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac'] }]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('pick-slides', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  });

  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('pick-srt', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('pick-any-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile']
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('generate-transcript', async (_event, payload: TranscriptPayload) => {
  const send = createThrottledProgressSender(_event.sender);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3-transcript-'));
  try {
    send({ stage: 'start', percent: null, label: 'Starting…' });
    const srtPath = await resolveSrtFromCaptions(payload.audioPath, payload.captions, tempDir, send);
    if (!srtPath) {
      throw new Error('No caption source is available to generate a transcript.');
    }

    const srtContent = fs.readFileSync(srtPath, 'utf8');
    const plainText = srtToPlainText(srtContent);
    const vttContent = srtToVtt(srtContent);

    return {
      success: true,
      srtPath,
      srtContent,
      plainText,
      vttContent
    };
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || 'Transcript generation failed.'
    };
  }
});

ipcMain.handle('save-transcript', async (_event, payload: { defaultBaseName?: string; format: 'txt' | 'srt' | 'vtt'; content: string }) => {
  const extension = payload.format;
  const filters = [
    payload.format === 'txt'
      ? { name: 'Text file', extensions: ['txt'] }
      : payload.format === 'srt'
        ? { name: 'SubRip subtitles', extensions: ['srt'] }
        : { name: 'WebVTT subtitles', extensions: ['vtt'] }
  ];

  const transcriptsDir = ensureOutputSubdir('transcripts');
  const baseName = payload.defaultBaseName || `transcript.${extension}`;
  const defaultSavePath = path.isAbsolute(baseName)
    ? baseName
    : path.join(transcriptsDir, path.basename(baseName));

  const saveResult = await dialog.showSaveDialog({
    defaultPath: defaultSavePath,
    filters
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true };
  }

  fs.writeFileSync(saveResult.filePath, payload.content, 'utf8');
  return { canceled: false, success: true, outputPath: saveResult.filePath };
});

ipcMain.handle('export-video', async (_event, payload: ExportPayload) => {
  const send = createThrottledProgressSender(_event.sender);
  const defaultOutput =
    payload.outputPath || path.join(ensureOutputSubdir('exports'), 'slideshow-video.mp4');

  const saveResult = await dialog.showSaveDialog({
    defaultPath: defaultOutput,
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true };
  }

  try {
    const r = await runExportCore(payload, saveResult.filePath, send);
    return {
      canceled: false,
      success: true,
      outputPath: r.outputPath,
      captionsApplied: r.captionsApplied,
      srtPath: r.srtPath
    };
  } catch (error: any) {
    return {
      canceled: false,
      success: false,
      error: error?.message || 'Export failed.'
    };
  }
});

ipcMain.handle('run-full-pipeline', async (_event, payload: ExportPayload) => {
  const send = createThrottledProgressSender(_event.sender);
  const base = safeFileBase(path.basename(payload.audioPath, path.extname(payload.audioPath)));
  const transcriptsDir = ensureOutputSubdir('transcripts');
  const exportsDir = ensureOutputSubdir('exports');
  const mp4Path = path.join(exportsDir, `${base}.mp4`);

  const TRANSCRIPT_END = 28;
  const SAVE_END = 35;
  const EXPORT_START = 35;

  try {
    send({ stage: 'pipeline', percent: null, label: 'Starting full export…' });
    let existingSrtPath: string | undefined;
    let plainTextResult: string | null = null;
    let srtContentResult: string | null = null;
    let vttContentResult: string | null = null;

    if (payload.captions?.enabled) {
      if (payload.captions.mode === 'importSrt' && !payload.captions.srtPath) {
        throw new Error('Captions are enabled. Choose an SRT file first.');
      }
      if (
        payload.captions.mode === 'whisperCpp' &&
        (!payload.captions.whisperExecutablePath || !payload.captions.whisperModelPath)
      ) {
        throw new Error('Captions are enabled. Choose the whisper.cpp executable and model file first.');
      }

      const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-transcript-'));
      const mapTranscriptOnly: ProgressSend = (p) => {
        if (p.percent == null) {
          send({ ...p, percent: null, label: p.label });
        } else {
          send({ ...p, percent: (p.percent / 100) * TRANSCRIPT_END, label: p.label });
        }
      };
      const srtPath = await resolveSrtFromCaptions(
        payload.audioPath,
        payload.captions,
        transcriptDir,
        mapTranscriptOnly
      );
      if (!srtPath) throw new Error('Could not resolve subtitles.');
      const srtContent = fs.readFileSync(srtPath, 'utf8');
      const plainText = srtToPlainText(srtContent);
      const vttContent = srtToVtt(srtContent);
      plainTextResult = plainText;
      srtContentResult = srtContent;
      vttContentResult = vttContent;

      send({ stage: 'save', percent: TRANSCRIPT_END, label: 'Saving TXT, SRT, and VTT…' });
      fs.writeFileSync(path.join(transcriptsDir, `${base}.txt`), plainText, 'utf8');
      fs.writeFileSync(path.join(transcriptsDir, `${base}.srt`), srtContent, 'utf8');
      fs.writeFileSync(path.join(transcriptsDir, `${base}.vtt`), vttContent, 'utf8');
      existingSrtPath = srtPath;
      send({ stage: 'save', percent: SAVE_END, label: 'Transcript files saved.' });
    }

    const mapExport: ProgressSend = (p) => {
      if (p.percent == null) {
        send({ ...p, percent: null, label: p.label });
      } else {
        const start = payload.captions?.enabled ? EXPORT_START : 0;
        send({ ...p, percent: start + (p.percent / 100) * (100 - start), label: p.label });
      }
    };

    const r = await runExportCore(payload, mp4Path, mapExport, {
      existingSrtPath: payload.captions?.enabled ? existingSrtPath : undefined
    });

    return {
      success: true,
      mp4Path: r.outputPath,
      transcriptPaths: payload.captions?.enabled
        ? {
            txt: path.join(transcriptsDir, `${base}.txt`),
            srt: path.join(transcriptsDir, `${base}.srt`),
            vtt: path.join(transcriptsDir, `${base}.vtt`)
          }
        : null,
      plainText: plainTextResult,
      srtContent: srtContentResult,
      vttContent: vttContentResult
    };
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || 'Pipeline failed.'
    };
  }
});
