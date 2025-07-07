import {
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  CameraControllerOptions,
  CameraRecordingOptions,
  CameraStreamingDelegate,
  CameraStreamingOptions,
  EventTriggerOption,
  HAP,
  H264Level,
  H264Profile,
  MediaContainerType,
  PrepareStreamCallback,
  PrepareStreamRequest,
  Resolution,
  SnapshotRequest,
  SnapshotRequestCallback,
  SRTPCryptoSuites,
  StreamingRequest,
  StreamRequestCallback,
  PrepareStreamResponse,
  StartStreamRequest,
  CameraRecordingDelegate,
} from 'homebridge';

import { LoxonePlatform } from '../../LoxonePlatform';
import { defaultFfmpegPath, reservePorts } from '@homebridge/camera-utils';
import { spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';
import { FfmpegStreamingProcess, StreamingDelegate as FfmpegStreamingDelegate } from './FfmpegStreamingProcess';
import { RecordingDelegate } from './RecordingDelegate';

interface SessionInfo {
  address: string;
  addressVersion: 'ipv4' | 'ipv6';
  videoPort: number;
  videoIncomingPort: number;
  videoCryptoSuite: SRTPCryptoSuites;
  videoSRTP: Buffer;
  videoSSRC: number;
  audioPort: number;
  audioIncomingPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
}

type ActiveSession = {
  mainProcess?: FfmpegStreamingProcess;
  returnProcess?: FfmpegStreamingProcess;
  timeout?: NodeJS.Timeout;
  socket?: Socket;
};

export class streamingDelegate implements CameraStreamingDelegate, FfmpegStreamingDelegate {
  public readonly controller: CameraController;
  public readonly recordingDelegate?: CameraRecordingDelegate;
  private readonly streamUrl: string;
  private readonly ip: string;
  private readonly base64auth: string;

  private pendingSessions: Record<string, SessionInfo> = {};
  private ongoingSessions: Record<string, ActiveSession> = {};

  private cachedSnapshot: Buffer | null = null;
  private cachedAt = 0;
  private readonly cacheTtlMs = 5000;
  private readonly hap: HAP;

  constructor(private readonly platform: LoxonePlatform, streamUrl: string, base64auth: string) {
    this.hap = this.platform.api.hap;
    this.streamUrl = streamUrl;
    this.base64auth = base64auth;

    const ipMatch = streamUrl.match(/http:\/\/([\d.]+)/);
    this.ip = ipMatch?.[1] ?? 'unknown';

    const enableHKSV = this.platform.config.enableHKSV ?? false;
    this.recordingDelegate = enableHKSV ? new RecordingDelegate({platform, streamUrl, base64auth}) : undefined;
    this.platform.log.info(`HKSV is ${enableHKSV ? 'Activated' : 'Disabled'} for this configuration.`);

    const resolutions: Resolution[] = [
      [320, 180, 30], [320, 240, 15], [320, 240, 30],
      [480, 270, 30], [480, 360, 30], [640, 360, 30],
      [640, 480, 30], [1024, 768, 30], [1280, 720, 30],
    ];

    const streamingOptions: CameraStreamingOptions = {
      supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
        resolutions,
      },
      audio: {
        twoWayAudio: false,
        codecs: [{
          type: AudioStreamingCodecType.AAC_ELD,
          samplerate: AudioStreamingSamplerate.KHZ_16,
        }],
      },
    };

    const recordingOptions: CameraRecordingOptions = {
      overrideEventTriggerOptions: [EventTriggerOption.MOTION, EventTriggerOption.DOORBELL],
      prebufferLength: 4000,
      mediaContainerConfiguration: [{
        type: MediaContainerType.FRAGMENTED_MP4,
        fragmentLength: 4000,
      }],
      video: {
        type: this.hap.VideoCodecType.H264,
        resolutions,
        parameters: {
          profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
      },
      audio: {
        codecs: [{
          type: this.hap.AudioRecordingCodecType.AAC_LC,
          samplerate: this.hap.AudioRecordingSamplerate.KHZ_32,
        }],
      },
    };

    const options: CameraControllerOptions = {
      cameraStreamCount: 5,
      delegate: this,
      streamingOptions,
      ...(this.recordingDelegate ? {
        recording: {
          options: recordingOptions,
          delegate: this.recordingDelegate,
        },
      } : {}),
    };

    this.controller = new this.hap.CameraController(options);
  }

  stopStream(sessionId: string): void {
    const session = this.ongoingSessions[sessionId];
    if (session) {
      session.timeout && clearTimeout(session.timeout);
      session.socket?.close();
      session.mainProcess?.stop();
      session.returnProcess?.stop();
      delete this.ongoingSessions[sessionId];
      this.platform.log.info('Stopped video stream.', this.ip);
    }
  }

  forceStopStream(sessionId: string): void {
    this.controller.forceStopStreamingSession(sessionId);
  }

  /** Public snapshot method with cache */
  public async getSnapshot(): Promise<Buffer | null> {
    const now = Date.now();
    if (this.cachedSnapshot && now - this.cachedAt < this.cacheTtlMs) {
      this.platform.log.debug(`[${this.ip}] Snapshot cache hit`);
      return this.cachedSnapshot;
    }

    return new Promise(resolve => {
      this.handleSnapshotRequest({ width: 640, height: 360 }, (err, buffer) => {
        if (err || !buffer) {
          this.platform.log.warn(`[${this.ip}] Snapshot request failed`);
          return resolve(null);
        }
        this.cachedSnapshot = buffer;
        this.cachedAt = now;
        resolve(buffer);
      });
    });
  }

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    this.platform.log.debug(`Snapshot requested: ${request.width} x ${request.height}`, this.ip);

    const ffmpeg = spawn('ffmpeg', [
      '-re', '-headers', `Authorization: Basic ${this.base64auth}\r\n`,
      '-i', `${this.streamUrl}`, '-frames:v', '1',
      '-update', '1', '-loglevel', 'info',
      '-hide_banner',
      '-nostdin',
      '-f', 'image2', '-vcodec', 'mjpeg', '-',
    ], { env: process.env });

    const buffers: Buffer[] = [];
    ffmpeg.stdout.on('data', d => buffers.push(d));
    ffmpeg.stderr.on('data', d => this.platform.log.info('SNAPSHOT: ' + d.toString()));

    ffmpeg.on('exit', (code, signal) => {
      if (signal || code !== 0) {
        this.platform.log.error(`Snapshot failed: code ${code}, signal ${signal}`, this.ip);
        callback(new Error('Snapshot process failed'));
      } else {
        this.platform.log.debug(`Successfully captured snapshot at ${request.width}x${request.height}`);
        callback(undefined, Buffer.concat(buffers));
      }
    });

    ffmpeg.on('error', err => {
      this.platform.log.error('Snapshot error: ' + err.message, this.ip);
      callback(err);
    });
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const videoIncomingPort = (await reservePorts({ count: 1 }))[0];
    const audioIncomingPort = (await reservePorts({ count: 1 }))[0];

    const sessionInfo: SessionInfo = {
      address: request.targetAddress,
      addressVersion: request.addressVersion,
      videoPort: request.video.port,
      videoIncomingPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: this.hap.CameraController.generateSynchronisationSource(),
      audioPort: request.audio.port,
      audioIncomingPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: this.hap.CameraController.generateSynchronisationSource(),
    };

    this.pendingSessions[request.sessionID] = sessionInfo;

    const response: PrepareStreamResponse = {
      video: {
        port: videoIncomingPort,
        ssrc: sessionInfo.videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: audioIncomingPort,
        ssrc: sessionInfo.audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };

    callback(undefined, response);
  }

  async handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): Promise<void> {
    switch (request.type) {
      case this.hap.StreamRequestTypes.START:
        this.platform.log.debug(`Start stream requested: ${request.video.width}x${request.video.height}`, this.ip);
        await this.startStream(request, callback);
        break;
      case this.hap.StreamRequestTypes.RECONFIGURE:
        this.platform.log.debug('Reconfigure stream (ignored)', this.ip);
        callback();
        break;
      case this.hap.StreamRequestTypes.STOP:
        this.platform.log.debug('Stop stream requested', this.ip);
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  /** Start FFmpeg-based stream to HomeKit */
  private async startStream(request: StartStreamRequest, callback: StreamRequestCallback): Promise<void> {
    const sessionInfo = this.pendingSessions[request.sessionID];
    if (!sessionInfo) {
      this.platform.log.error('Session info not found', this.ip);
      callback(new Error('Session info not found'));
      return;
    }

    const ffmpegArgs = buildFFmpegArgs(sessionInfo, this.streamUrl, this.base64auth);
    const session: ActiveSession = {};
    session.socket = createSocket(sessionInfo.addressVersion === 'ipv6' ? 'udp6' : 'udp4');

    session.socket.on('error', err => {
      this.platform.log.error('UDP socket error: ' + err.message, this.ip);
      this.stopStream(request.sessionID);
    });

    session.socket.on('message', () => {
      clearTimeout(session.timeout!);
      session.timeout = setTimeout(() => {
        this.platform.log.info('No RTCP received; stopping stream.', this.ip);
        this.controller.forceStopStreamingSession(request.sessionID);
        this.stopStream(request.sessionID);
      }, request.video.rtcp_interval * 5 * 1000);
    });

    session.socket.bind(sessionInfo.videoIncomingPort);

    session.mainProcess = new FfmpegStreamingProcess(
      this.ip, request.sessionID, defaultFfmpegPath,
      ffmpegArgs, this.platform.log, true, this, callback,
    );

    this.ongoingSessions[request.sessionID] = session;
    delete this.pendingSessions[request.sessionID];
  }
}

/**
 * Genereert de FFmpeg argumenten voor SRTP videostreaming van MJPEG → H264.
 */
function buildFFmpegArgs(sessionInfo: SessionInfo, streamUrl: string, base64auth: string): string[] {
  const mtu = 1316;
  return [
    '-headers', `Authorization: Basic ${base64auth}\r\n`,
    '-use_wallclock_as_timestamps', '1',
    '-probesize', '32',
    '-analyzeduration', '0',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-max_delay', '0',
    '-re',
    '-i', streamUrl,
    '-an', '-sn', '-dn',
    '-codec:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'mpeg',
    '-r', '25',
    '-f', 'rawvideo',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-crf', '22',
    '-filter:v', 'scale=\'min(1280,iw)\':\'min(720,ih)\':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-b:v', '299k',
    '-payload_type', '99',
    '-ssrc', `${sessionInfo.videoSSRC}`,
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', sessionInfo.videoSRTP.toString('base64'),
    `srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${mtu}`,
    '-progress', 'pipe:1',
    '-hide_banner',
    '-nostdin',
  ];
}
