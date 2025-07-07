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

const defaultPrebufferDuration = 15000;

export class PreBuffer {
  prebufferFmp4: PrebufferFmp4[] = [];
  events = new EventEmitter();
  released = false;
  ftyp?: MP4Atom;
  moov?: MP4Atom;
  idrInterval = 0;
  prevIdr = 0;
  prebufferSession?: Mp4Session;

  private readonly log: Logger;
  private readonly ffmpegInput: string[];
  private readonly cameraName: string;
  private readonly ffmpegPath: string;

  constructor(ffmpegInput: string[], cameraName: string, videoProcessor: string, log: Logger) {
    this.ffmpegInput = ffmpegInput;
    this.cameraName = cameraName;
    this.ffmpegPath = videoProcessor;
    this.log = log;
  }

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
      fmp4OutputServer.close();
      const parser = parseFragmentedMP4(socket);
      for await (const atom of parser) {
        const now = Date.now();
        if (!this.ftyp) {
          this.ftyp = atom;
        } else if (!this.moov) {
          this.moov = atom;
        } else {
          if (atom.type === 'mdat') {
            if (this.prevIdr) {
              this.idrInterval = now - this.prevIdr;
            }
            this.prevIdr = now;
          }
          this.prebufferFmp4.push({ atom, time: now });
        }

        while (this.prebufferFmp4.length && this.prebufferFmp4[0].time < now - defaultPrebufferDuration) {
          this.prebufferFmp4.shift();
        }
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

  async getVideo(requestedPrebuffer: number): Promise<string[]> {
    const waitUntil = Date.now() + 7000;
    while (!this.moov && Date.now() < waitUntil) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!this.moov) {
      this.log.error(`[PreBuffer] Timeout: moov atom not available for camera ${this.cameraName}`);
      throw new Error('moov atom not yet available');
    }

    const server = new Server(socket => {
      server.close();
      const writeAtom = (atom: MP4Atom) => socket.write(Buffer.concat([atom.header, atom.data]));

      if (this.ftyp) {
        writeAtom(this.ftyp);
      }
      if (this.moov) {
        writeAtom(this.moov);
      }

      const now = Date.now();
      let needMoof = true;

      for (const prebuffer of this.prebufferFmp4) {
        if (prebuffer.time < now - requestedPrebuffer) {
          continue;
        }
        if (needMoof && prebuffer.atom.type !== 'moof') {
          continue;
        }
        needMoof = false;
        writeAtom(prebuffer.atom);
      }

      this.events.on('atom', writeAtom);

      const cleanup = () => {
        this.events.removeListener('atom', writeAtom);
        this.events.removeListener('killed', cleanup);
        socket.removeAllListeners();
        socket.destroy();
      };

      this.events.once('killed', cleanup);
      socket.once('end', cleanup);
      socket.once('close', cleanup);
      socket.once('error', cleanup);
    });

    setTimeout(() => server.close(), 30000);
    const port = await listenServer(server, this.log);

    return ['-f', 'mp4', '-i', `tcp://127.0.0.1:${port}`];
  }
}
