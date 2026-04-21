type TranscriptionProgressPayload = {
  stage: string;
  percent: number | null;
  label: string;
};

declare global {
  interface Window {
    appApi: {
      pickAudio: () => Promise<string[]>;
      pickSlides: () => Promise<string[]>;
      pickSrt: () => Promise<string | null>;
      pickAnyFile: () => Promise<string | null>;
      generateTranscript: (payload: any) => Promise<any>;
      saveTranscript: (payload: any) => Promise<any>;
      exportVideo: (payload: any) => Promise<any>;
      runFullPipeline: (payload: any) => Promise<any>;
      runTranscriptsOnly: (payload: any) => Promise<any>;
      onTranscriptionProgress: (callback: (payload: TranscriptionProgressPayload) => void) => () => void;
    };
  }
}

export {};
