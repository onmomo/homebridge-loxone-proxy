import { PlatformAccessory } from 'homebridge';
import { LoxonePlatform } from '../../LoxonePlatform';
import { streamingDelegate } from '../hksv/StreamingDelegate';
import { RecordingDelegate } from '../hksv/RecordingDelegate';

/**
 * CameraService wraps the streamingDelegate and registers the camera
 * stream with Homebridge via the CameraController.
 *
 * It supports HomeKit video streaming, snapshot capture, and optionally
 * HomeKit Secure Video (HKSV) when enabled in the platform config.
 */
export class CameraService {
  private readonly platform: LoxonePlatform;
  private readonly accessory: PlatformAccessory;
  private readonly ip: string;
  private readonly base64auth: string;

  private streamingDelegate!: streamingDelegate;

  /**
   * Constructs a new CameraService instance.
   *
   * @param platform - The main LoxonePlatform instance (Homebridge plugin context)
   * @param accessory - The associated Homebridge camera accessory
   * @param ip - IP address or stream URL of the camera
   * @param base64auth - Base64-encoded basic authentication string
   */
  constructor(
    platform: LoxonePlatform,
    accessory: PlatformAccessory,
    ip: string,
    base64auth: string,
  ) {
    this.platform = platform;
    this.accessory = accessory;
    this.ip = ip;
    this.base64auth = base64auth;

    this.setupService();
  }

  /**
   * Initializes the streamingDelegate (responsible for streaming and recording)
   * and registers the CameraController with the Homebridge accessory.
   */
  private setupService(): void {
    this.streamingDelegate = new streamingDelegate(this.platform, this.ip, this.base64auth);
    this.accessory.configureController(this.streamingDelegate.controller);
  }

  /**
   * Returns a snapshot (JPEG buffer) from the camera.
   * This is used by HomeKit for camera thumbnails and can also be reused
   * by motion detection services if needed.
   *
   * @returns A Promise resolving to a JPEG image buffer or null if snapshot failed.
   */
  public async getSnapshot(): Promise<Buffer | null> {
    return this.streamingDelegate.getSnapshot();
  }

  /**
   * Checks if HomeKit Secure Video (HKSV) is currently active.
   * This is used to determine if motion detection should be skipped
   * while HKSV is recording.
  */
  public isHKSVActive(): boolean {
    return !!(this.streamingDelegate.recordingDelegate as RecordingDelegate)?.isActive?.();
  }
}
