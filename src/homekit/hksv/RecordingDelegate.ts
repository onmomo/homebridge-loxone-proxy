import {
  APIEvent,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  HAP,
  HDSProtocolSpecificErrorReason,
  RecordingPacket,
  H264Level,
  H264Profile,
} from 'homebridge';
import type { Logger } from 'homebridge';
import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';
import { once } from 'events';
import { Buffer } from 'buffer';
import { env } from 'process';
import { Server, AddressInfo } from 'net';
import { LoxonePlatform } from '../../LoxonePlatform';
import { PreBuffer, Mp4Session } from './Prebuffer';

export interface MP4Atom {
  header: Buffer;
  length: number;
  type: string;
  data: Buffer;
}

export interface FFMpegFragmentedMP4Session {
  generator: AsyncGenerator<MP4Atom>;
  cp: ChildProcess;
}

export interface RecordingDelegateOptions {
  platform: LoxonePlatform;
  streamUrl: string;
  base64auth: string;
}

export const PREBUFFER_LENGTH = 4000;
const GOP_FPS = 30;
const GOP_SECONDS = 1;
const GOP_SIZE = GOP_FPS * GOP_SECONDS;

/**
 * Binds a TCP server to a random port and waits for it to listen.
 */
export async function listenServer(server: Server, log: Logger): Promise<number> {
  let listening = false;
  while (!listening) {
    const port = 10000 + Math.floor(Math.random() * 30000);
    server.listen(port);
    try {
      await once(server, 'listening');
      listening = true;
      return (server.address() as AddressInfo).port;
    } catch (e) {
      log.error('Error while listening to server:', e);
    }
  }
  throw new Error('Failed to bind server to a port');
}

/**
 * Reads exactly `length` bytes from a readable stream or throws on premature end.
 */
export async function readLength(readable: Readable, length: number): Promise<Buffer> {
  if (!length) {
    return Buffer.alloc(0);
  }
  const existing = readable.read(length);
  if (existing) {
    return existing;
  }

  return new Promise((resolve, reject) => {
    const r = () => {
      const chunk = readable.read(length);
      if (chunk) {
        cleanup();
        resolve(chunk);
      }
    };
    const e = () => {
      cleanup();
      reject(new Error(`stream ended before ${length} bytes`));
    };
    const cleanup = () => {
      readable.removeListener('readable', r);
      readable.removeListener('end', e);
    };
    readable.on('readable', r);
    readable.on('end', e);
  });
}

/**
 * MP4 fragment parser from raw ffmpeg pipe.
 */
export async function* parseFragmentedMP4(readable: Readable): AsyncGenerator<MP4Atom> {
  while (true) {
    let header: Buffer;
    try {
      header = await readLength(readable, 8);
    } catch (err) {
      break;
    }
    const length = header.readInt32BE(0) - 8;
    const type = header.slice(4).toString();
    const data = await readLength(readable, length);
    yield { header, length, type, data };
  }
}

/**
 * Handles HomeKit Secure Video recording session lifecycle.
 */
export class RecordingDelegate implements CameraRecordingDelegate {
  private readonly hap: HAP;
  private readonly log: Logger;
  private readonly videoProcessor: string;
  private readonly streamUrl: string;
  private readonly base64auth: string;

  private preBufferSession?: Mp4Session;
  private preBuffer?: PreBuffer;
  private currentRecordingConfiguration?: CameraRecordingConfiguration;
  private activeFFmpegProcesses = new Map<number, ChildProcess>();
  private streamAbortControllers = new Map<number, AbortController>();

  constructor({ platform, streamUrl, base64auth }: RecordingDelegateOptions) {
    this.log = platform.log;
    this.hap = platform.api.hap;
    this.videoProcessor = 'ffmpeg';
    this.streamUrl = streamUrl;
    this.base64auth = base64auth;

    platform.api.on(APIEvent.SHUTDOWN, () => {
      this.preBufferSession?.process?.kill();
      this.preBufferSession?.server?.close();
      this.activeFFmpegProcesses.forEach(proc => proc.kill('SIGTERM'));
      this.activeFFmpegProcesses.clear();
      this.streamAbortControllers.clear();
    });
  }

  public isActive(): boolean {
    return this.streamAbortControllers.size > 0;
  }

  updateRecordingActive(active: boolean): Promise<void> {
    this.log.info(`Recording active: ${active}`, this.streamUrl);
    return Promise.resolve();
  }

  updateRecordingConfiguration(config: CameraRecordingConfiguration | undefined): Promise<void> {
    this.log.info('Recording configuration updated', this.streamUrl);
    this.currentRecordingConfiguration = config;
    return Promise.resolve();
  }

  /**
   * Handles incoming HomeKit recording request.
   */
  async *handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket> {
    this.log.info(`Recording stream request ID: ${streamId}`, this.streamUrl);
    const config = this.currentRecordingConfiguration;
    if (!config) {
      this.log.error('Missing recording config', this.streamUrl);
      return;
    }

    const abortController = new AbortController();
    this.streamAbortControllers.set(streamId, abortController);

    try {
      await this.startPreBuffer();
      const { cp, generator } = await this.launchFragmentSession(config, streamId);
      let count = 0;
      for await (const fragment of this.consumeFragments(generator, cp, streamId)) {
        if (abortController.signal.aborted) {
          break;
        }
        count++;
        this.log.debug(`Fragment #${count}, ${fragment.length}B`, this.streamUrl);
        yield { data: fragment, isLast: false };
      }
    } catch (err) {
      this.log.error(`Stream error: ${err}`, this.streamUrl);
      yield { data: Buffer.alloc(0), isLast: true };
    } finally {
      this.streamAbortControllers.delete(streamId);
    }
  }

  /**
   * Releases resources for closed stream.
   */
  closeRecordingStream(streamId: number, reason?: HDSProtocolSpecificErrorReason): void {
    if (!this.streamAbortControllers.has(streamId)) {
      return;
    }

    this.log.info(`Stream ${streamId} closed, reason: ${reason}`, this.streamUrl);
    this.streamAbortControllers.get(streamId)?.abort();
    this.streamAbortControllers.delete(streamId);

    const process = this.activeFFmpegProcesses.get(streamId);
    if (process && !process.killed) {
      process.kill('SIGTERM');
    }
    this.activeFFmpegProcesses.delete(streamId);
  }

  /**
   * Initializes prebuffer pipeline using FFmpeg.
   */
  async startPreBuffer(): Promise<void> {
    this.log.info(`Starting prebuffer for ${this.streamUrl}`);
    if (!this.preBuffer) {
      const ffmpegInput = [
        '-f', 'mjpeg',
        '-r', '10',
        '-re',
        '-fflags', '+genpts+discardcorrupt',
        '-timeout', '5000000',
        '-headers', `Authorization: Basic ${this.base64auth}\r\n`,
        '-i', this.streamUrl,
      ];
      this.preBuffer = new PreBuffer(ffmpegInput, this.streamUrl, this.videoProcessor, this.log);
      this.preBufferSession = await this.preBuffer.startPreBuffer();
    }
  }

  /**
   * Sets up FFmpeg to convert buffered data into fragmented MP4.
   */
  private async launchFragmentSession(config: CameraRecordingConfiguration, streamId: number): Promise<FFMpegFragmentedMP4Session> {
    const input = await this.preBuffer!.getVideo(config.mediaContainerConfiguration.fragmentLength ?? PREBUFFER_LENGTH);

    const args = [
      '-vcodec', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', config.videoCodec.parameters.profile === H264Profile.HIGH ? 'high' : 'main',
      '-level:v', config.videoCodec.parameters.level === H264Level.LEVEL4_0 ? '4.0' : '3.1',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', '600k',
      '-maxrate', '700k',
      '-bufsize', '1400k',
      '-g', '30',
      '-keyint_min', '15',
      '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*1)',
    ];

    const cp = spawn(this.videoProcessor, [...input, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    if (cp.stderr) {
      cp.stderr.on('data', d => {
        const msg = d.toString();
        if (msg.includes('moov') || msg.toLowerCase().includes('error')) {
          this.log.warn(`[FFmpeg]: ${msg.trim()}`);
        }
      });
    }

    this.activeFFmpegProcesses.set(streamId, cp);

    return {
      cp,
      generator: parseFragmentedMP4(cp.stdout!),
    };
  }

  /**
   * Reads and assembles moof+mdat fragment pairs from ffmpeg.
   */
  private async *consumeFragments(
    generator: AsyncGenerator<MP4Atom>,
    cp: ChildProcess,
    streamId: number,
  ): AsyncGenerator<Buffer> {
    let moof: Buffer | null = null;
    let pending: Buffer[] = [];

    try {
      for await (const atom of generator) {
        pending.push(atom.header, atom.data);
        if (atom.type === 'moov') {
          yield Buffer.concat(pending);
          pending = [];
        } else if (atom.type === 'moof') {
          moof = Buffer.concat([atom.header, atom.data]);
        } else if (atom.type === 'mdat' && moof) {
          yield Buffer.concat([moof, atom.header, atom.data]);
          moof = null;
        }
      }
    } finally {
      if (!cp.killed) {
        cp.kill('SIGTERM');
        await new Promise(resolve => cp.once('exit', resolve));
      }
      this.activeFFmpegProcesses.delete(streamId);
    }
  }
}
