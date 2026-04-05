import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type TranscriptionProgressPayload = {
  stage: string;
  percent: number | null;
  label: string;
};

const TRANSCRIPTION_PROGRESS = 'transcription-progress';

contextBridge.exposeInMainWorld('appApi', {
  pickAudio: () => ipcRenderer.invoke('pick-audio'),
  pickSlides: () => ipcRenderer.invoke('pick-slides'),
  pickSrt: () => ipcRenderer.invoke('pick-srt'),
  pickAnyFile: () => ipcRenderer.invoke('pick-any-file'),
  generateTranscript: (payload: any) => ipcRenderer.invoke('generate-transcript', payload),
  saveTranscript: (payload: any) => ipcRenderer.invoke('save-transcript', payload),
  exportVideo: (payload: any) => ipcRenderer.invoke('export-video', payload),
  runFullPipeline: (payload: any) => ipcRenderer.invoke('run-full-pipeline', payload),
  onTranscriptionProgress: (callback: (payload: TranscriptionProgressPayload) => void) => {
    const listener = (_event: IpcRendererEvent, payload: TranscriptionProgressPayload) => {
      callback(payload);
    };
    ipcRenderer.on(TRANSCRIPTION_PROGRESS, listener);
    return () => {
      ipcRenderer.removeListener(TRANSCRIPTION_PROGRESS, listener);
    };
  }
});
