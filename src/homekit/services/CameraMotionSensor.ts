import { PlatformAccessory } from 'homebridge';
import { LoxonePlatform } from '../../LoxonePlatform';
import { BaseService } from './BaseService';
import { CameraService } from './Camera';
import sharp from 'sharp';

/**
 * CameraMotionSensor performs pixel-diff motion detection using sharp,
 * and skips polling during active HKSV recording sessions.
 */
export class CameraMotionSensor extends BaseService {
  private readonly pollIntervalMs = 1000;
  private readonly failureBackoffMs = 5000;
  private readonly pixelDiffThreshold = 0.04;
  private readonly fallbackSizeDeltaMin = 0.04;
  private readonly fallbackSizeDeltaMax = 0.30;
  private readonly cooldownMs = 8000;
  private readonly resetDelayMs = 15000;

  private state = { MotionDetected: false };

  private lastSnapshotBuffer?: Buffer;
  private lastSnapshotSize?: number;
  private lastTriggerTime = 0;
  private consecutiveFailures = 0;
  private polling = false;

  constructor(
    readonly platform: LoxonePlatform,
    readonly accessory: PlatformAccessory,
    readonly camera: CameraService,
  ) {
    super(platform, accessory);
    this.setupService();
    this.startPolling();
  }

  setupService(): void {
    this.service = this.accessory.getService(this.platform.Service.MotionSensor)
      ?? this.accessory.addService(this.platform.Service.MotionSensor);

    this.service.getCharacteristic(this.platform.Characteristic.MotionDetected)
      .onGet(() => this.state.MotionDetected);
  }

  private startPolling(): void {
    this.platform.log.debug(`[${this.accessory.displayName}] Starting sharp-based motion detection`);
    this.polling = true;
    this.schedulePoll(this.pollIntervalMs);
  }

  private schedulePoll(delay: number): void {
    setTimeout(() => this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (!this.polling) {
      return;
    }

    // Skip motion detection if HKSV is currently recording
    if (this.camera.isHKSVActive?.()) {
      this.platform.log.debug(`[${this.accessory.displayName}] Skipping motion detection (HKSV active)`);
      this.schedulePoll(this.pollIntervalMs);
      return;
    }

    const snapshot = await this.camera.getSnapshot();

    if (!snapshot) {
      this.consecutiveFailures++;
      this.platform.log.warn(`[${this.accessory.displayName}] Snapshot unavailable`);
      this.schedulePoll(this.failureBackoffMs);
      return;
    }

    const now = Date.now();

    try {
      if (this.lastSnapshotBuffer) {
        const [prev, curr] = await Promise.all([
          sharp(this.lastSnapshotBuffer).resize(160, 90).greyscale().raw().toBuffer(),
          sharp(snapshot).resize(160, 90).greyscale().raw().toBuffer(),
        ]);

        const diffPixels = this.countPixelDiff(prev, curr);
        const totalPixels = prev.length;
        const diffRatio = diffPixels / totalPixels;

        if (diffRatio > this.pixelDiffThreshold && now - this.lastTriggerTime > this.cooldownMs) {
          this.triggerMotion(now);
        } else if (
          this.state.MotionDetected &&
          now - this.lastTriggerTime > this.resetDelayMs
        ) {
          this.resetMotion();
        }
      }
    } catch (err) {
      // fallback to snapshot size delta
      const size = snapshot.length;
      if (this.lastSnapshotSize) {
        const delta = Math.abs(size - this.lastSnapshotSize) / this.lastSnapshotSize;
        if (
          delta > this.fallbackSizeDeltaMin &&
          delta < this.fallbackSizeDeltaMax &&
          now - this.lastTriggerTime > this.cooldownMs
        ) {
          this.platform.log.warn(`[${this.accessory.displayName}] ⚠️ Using fallback motion detection`);
          this.triggerMotion(now);
        } else if (
          this.state.MotionDetected &&
          now - this.lastTriggerTime > this.resetDelayMs
        ) {
          this.resetMotion();
        }
      }
      this.lastSnapshotSize = size;
    }

    this.lastSnapshotBuffer = snapshot;
    this.schedulePoll(this.pollIntervalMs);
  }

  private countPixelDiff(buf1: Buffer, buf2: Buffer): number {
    let diff = 0;
    for (let i = 0; i < buf1.length; i++) {
      if (Math.abs(buf1[i] - buf2[i]) > 15) {
        diff++;
      } // Pixel intensity threshold
    }
    return diff;
  }

  private triggerMotion(now: number): void {
    this.platform.log.info(`[${this.accessory.displayName}] 📸 Motion detected`);
    this.state.MotionDetected = true;
    this.lastTriggerTime = now;
    this.service?.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);
  }

  private resetMotion(): void {
    this.platform.log.info(`[${this.accessory.displayName}] ⏸️ Motion ended`);
    this.state.MotionDetected = false;
    this.service?.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
  }

  public stop(): void {
    this.polling = false;
  }
}
