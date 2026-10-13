declare module 'jmuxer' {
  export interface JMuxerOptions {
    node: HTMLVideoElement | string;
    mode?: 'video' | 'audio' | 'both';
    flushingTime?: number;
    fps?: number;
    debug?: boolean;
    onError?: (err: unknown) => void;
  }
  export default class JMuxer {
    constructor(options: JMuxerOptions);
    feed(data: { video?: Uint8Array; audio?: Uint8Array; duration?: number }): void;
    reset(): void;
    destroy(): void;
  }
}
