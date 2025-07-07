import { ChildProcess, spawn, StdioNull, StdioPipe } from 'child_process';
import EventEmitter from 'events';
import { createServer, Server } from 'net';
import { listenServer, MP4Atom, parseFragmentedMP4 } from './RecordingDelegate';
import type { Logger } from 'homebridge';

interface PrebufferFmp4 {
  atom: MP4Atom;
  time: number;
}

export interface Mp4Session {
  server: Server;
  process: ChildProcess;
}

// Reasonable upper bound to avoid memory abuse
const MAX_FRAGMENTS = 300;

/**
 * PreBuffer captures a sliding window of fragmented MP4 atoms
 * from an FFmpeg-transcoded live stream. This buffer is used to
 * deliver pre-recorded video to consumers such as HomeKit Secure Video.
 */
export class PreBuffer {
  private prebufferFmp4: PrebufferFmp4[] = [];
  private events = new EventEmitter();
  private prebufferSession?: Mp4Session;

  private readonly log: Logger;
  private readonly ffmpegInput: string[];
  private readonly cameraName: string;
  private readonly ffmpegPath: string;
  private readonly prebufferDuration: number;

  /**
   * Constructs a new PreBuffer instance.
   * @param ffmpegInput - FFmpeg input arguments (e.g., source URL and headers)
   * @param cameraName - Identifier for logging/debugging
   * @param videoProcessor - Path to ffmpeg binary
   * @param log - Logger instance from the platform
   * @param prebufferDurationMs - Optional max time in milliseconds to buffer (default 15000)
   */
  constructor(
    ffmpegInput: string[],
    cameraName: string,
    videoProcessor: string,
    log: Logger,
    prebufferDurationMs = 15000,
  ) {
    this.ffmpegInput = ffmpegInput;
    this.cameraName = cameraName;
    this.ffmpegPath = videoProcessor;
    this.log = log;
    this.prebufferDuration = prebufferDurationMs;
  }

  /**
   * Launches FFmpeg and a TCP server to receive fragmented MP4 data.
   * Fragments are stored in memory and emitted as 'atom' events.
   */
  async startPreBuffer(): Promise<Mp4Session> {
    if (this.prebufferSession) {
      return this.prebufferSession;
    }

    const vcodec = [
      '-vcodec', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-r', '10',
      '-an',
    ];

    const fmp4OutputServer: Server = createServer(async (socket) => {
      fmp4OutputServer.close(); // Accept one connection only
      const parser = parseFragmentedMP4(socket);

      for await (const atom of parser) {
        const now = Date.now();
        this.handleAtom(atom, now);
        this.events.emit('atom', atom);
      }
    });

    const fmp4Port = await listenServer(fmp4OutputServer, this.log);

    const ffmpegOutput = [
      '-f', 'mp4',
      ...vcodec,
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      `tcp://127.0.0.1:${fmp4Port}`,
    ];

    const debug = false;
    const stdioValue: StdioPipe | StdioNull = debug ? 'pipe' : 'ignore';
    const ffmpegArgs = [...this.ffmpegInput, ...ffmpegOutput];

    this.log.debug(`[PreBuffer] FFmpeg command: ${this.ffmpegPath} ${ffmpegArgs.join(' ')}`);

    const cp = spawn(this.ffmpegPath, ffmpegArgs, {
      env: process.env,
      stdio: stdioValue,
    });

    cp.on('exit', (code, signal) => {
      this.log.error(`[PreBuffer] FFmpeg exited with code ${code}, signal ${signal}`, this.cameraName);
    });

    if (cp.stderr) {
      cp.stderr.on('data', data => {
        const output = data.toString();
        if (output.toLowerCase().includes('error')) {
          this.log.error(`[PreBuffer] FFmpeg: ${output.trim()}`, this.cameraName);
        }
      });
    }

    this.prebufferSession = { server: fmp4OutputServer, process: cp };
    return this.prebufferSession;
  }

  /**
   * Adds an atom to the buffer and evicts older ones beyond time or count limits.
   */
  private handleAtom(atom: MP4Atom, timestamp: number): void {
    this.prebufferFmp4.push({ atom, time: timestamp });

    // Evict by age
    const minTime = timestamp - this.prebufferDuration;
    while (this.prebufferFmp4.length && this.prebufferFmp4[0].time < minTime) {
      this.prebufferFmp4.shift();
    }

    // Evict by count
    while (this.prebufferFmp4.length > MAX_FRAGMENTS) {
      this.prebufferFmp4.shift();
    }

    this.log.debug(`[PreBuffer] Stored atom: ${atom.type}, buffer size: ${this.prebufferFmp4.length}`);
  }

  /**
   * Provides a TCP input stream to be read by a consumer such as FFmpeg.
   * The stream starts with the current buffered atoms and continues with live atoms.
   * @param requestedPrebuffer - Number of milliseconds of past fragments to include
   * @returns An array of FFmpeg arguments to read the stream
   */
  async getVideo(requestedPrebuffer: number): Promise<string[]> {
    const server = new Server(socket => {
      server.close();

      const now = Date.now();
      let count = 0;

      for (const fragment of this.prebufferFmp4) {
        if (fragment.time >= now - requestedPrebuffer) {
          socket.write(Buffer.concat([fragment.atom.header, fragment.atom.data]));
          count++;
        }
      }

      this.log.debug(`[PreBuffer] Sent ${count} buffered atoms to consumer`);

      const onNewAtom = (atom: MP4Atom) => {
        socket.write(Buffer.concat([atom.header, atom.data]));
      };

      this.events.on('atom', onNewAtom);

      const cleanup = () => {
        this.events.removeListener('atom', onNewAtom);
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.once('end', cleanup);
      socket.once('close', cleanup);
      socket.once('error', cleanup);
      this.events.once('killed', cleanup);
    });

    setTimeout(() => server.close(), 30000); // Safety timeout
    const port = await listenServer(server, this.log);

    return ['-f', 'mp4', '-i', `tcp://127.0.0.1:${port}`];
  }
}
