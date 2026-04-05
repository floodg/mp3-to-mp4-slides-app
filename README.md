# MP3 to MP4 Slides App

A desktop Electron app that converts an MP3 (or other supported audio file) into an MP4 slideshow video using uploaded slide images.

## Why this stack

**TypeScript + Electron + FFmpeg** is the best practical choice here because:

- It runs as a real desktop app on Windows/macOS/Linux
- It can safely access local files
- FFmpeg gives reliable, high-quality MP4 output
- TypeScript keeps the codebase easier to maintain and extend
- You can later add features like transitions, captions, branding, and presets

## Features in this starter

- Pick an audio file
- Add multiple slide images
- Reorder slides
- Set per-slide duration manually
- Leave slide durations blank to auto-balance across audio length
- Export to MP4
- Choose HD or Full HD output
- Optional captions via:
  - imported `.srt` subtitle file
  - auto-generated transcription using a local `whisper.cpp` executable + model
- Burn captions directly into the exported MP4
- Basic caption styling controls (font size and bottom margin)
- Extract transcript files separately as:
  - `.txt`
  - `.srt`
  - `.vtt`
- Preview transcript text inside the app before saving

## Install

```bash
npm install
npm start
```

## Build

```bash
npm run build
```

## Caption and transcript workflow options

### Option 1: Import an existing SRT

1. Enable captions / transcript tools in the app
2. Choose **Import SRT file**
3. Select your `.srt`
4. Click **Generate / Load Transcript** to preview and enable transcript export
5. Save TXT, SRT, or VTT if needed
6. Export MP4

### Option 2: Auto-transcribe with whisper.cpp

Use **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** (local inference, no API keys). Build or install a `whisper-cli` / `main` binary from that project, then point this app at the executable and a GGML model file.

#### Get whisper.cpp

- **Repository:** [github.com/ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp)
- **Build:** Follow the instructions in the upstream README (CMake / `cmake --build` on Windows, etc.). You need a CLI that accepts `-m`, `-f`, `-osrt`, and `-of` like `whisper-cli`.

#### Get the **base.en** model (English-only)

The **`base.en`** model is English-only, smaller, and usually faster than the multilingual `base` model, with good quality for many podcasts and voiceovers. The file is typically named **`ggml-base.en.bin`**.

1. **Download script (Git Bash / WSL / macOS / Linux)** — from the cloned `whisper.cpp` repo:

   ```bash
   ./models/download-ggml-model.sh base.en
   ```

   This puts `ggml-base.en.bin` under `whisper.cpp/models/`.

2. **Direct download** — save the file anywhere you like, e.g. next to your other models:

   - [ggml-base.en.bin on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin)  
     (from the [ggerganov/whisper.cpp models collection](https://huggingface.co/ggerganov/whisper.cpp))

   **Windows (PowerShell)** in the folder where you want the model:

   ```powershell
   Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" -OutFile "ggml-base.en.bin"
   ```

#### Use it in this app

1. Enable captions / transcript tools in the app
2. Choose **Generate transcript with whisper.cpp**
3. Select the **whisper.cpp executable** (`whisper-cli`, `main`, or your built binary)
4. Select the **model file** (`ggml-base.en.bin`)
5. Click **Generate / Load Transcript**
6. Save TXT, SRT, or VTT if needed
7. Export MP4

The app will:

- convert the source audio to mono 16kHz WAV
- run `whisper.cpp`
- generate an SRT file in a temp folder
- derive TXT and VTT from that transcript
- burn the captions into the video during export if captions are enabled

## Notes

- This starter uses `ffmpeg-static` and `ffprobe-static`
- Images are scaled to fit the selected resolution with letterboxing/padding when needed
- The exported video is trimmed to the audio length using `-shortest`
- Captions are currently **burned in** rather than added as a toggleable subtitle track
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) is expected to support arguments similar to:

```bash
whisper-cli -m ggml-base.en.bin -f input.wav -osrt -of transcript
```

If your local build uses a different executable name, you can still select it as long as it accepts those arguments.

## Good next features

- Word-by-word karaoke captions
- Caption theme presets
- Ken Burns pan/zoom effect
- Fade/crossfade between slides
- Add text overlays per slide
- Drag-and-drop slide ordering
- Save/load project files
- Export progress bar
- Background blur instead of black padding
