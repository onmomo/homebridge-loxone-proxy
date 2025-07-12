import { BaseService } from './BaseService';
import { Service } from 'homebridge';

interface ZoneDefinition {
  id: number;
  name: string;
  duration: number;
  setByLogic?: boolean;
}

export class IrrigationSystem extends BaseService {
  private zoneValves: Map<number, Service> = new Map();
  private durationUpdateInterval: NodeJS.Timeout | null = null;

  setupService(): void {
    this.service =
      this.accessory.getService(this.platform.Service.IrrigationSystem) ||
      this.accessory.addService(this.platform.Service.IrrigationSystem);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);
    this.service.setCharacteristic(
      this.platform.Characteristic.ProgramMode,
      this.platform.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
    );
    this.service.setCharacteristic(this.platform.Characteristic.InUse, 0);
    this.service.setCharacteristic(this.platform.Characteristic.Active, 0);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateService(message: { state: string; value: any }): void {
    const { Characteristic } = this.platform;

    switch (message.state) {
      case 'rainActive':
        this.service!.updateCharacteristic(
          Characteristic.Active,
          message.value ? Characteristic.Active.INACTIVE : Characteristic.Active.ACTIVE,
        );
        break;

      case 'zones': {
        try {
          const zones: ZoneDefinition[] =
            typeof message.value === 'string' ? JSON.parse(message.value) : message.value;

          if (!Array.isArray(zones)) {
            this.platform.log.warn(`[${this.device.name}] zones is not an array`);
            break;
          }

          this.platform.log.info(`[${this.device.name}] Setting up ${zones.length} zones`);
          this.setupZones(zones);
          this.startRemainingDurationUpdater();
        } catch (err) {
          this.platform.log.warn(`[${this.device.name}] Invalid zone data: ${message.value}`);
        }
        break;
      }

      case 'currentZone': {
        const now = Date.now();

        for (const [, valve] of this.zoneValves.entries()) {
          valve.updateCharacteristic(Characteristic.InUse, 0);
          valve.updateCharacteristic(Characteristic.Active, 0);
          valve.updateCharacteristic(Characteristic.RemainingDuration, 0);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((valve as any).__zoneMeta) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (valve as any).__zoneMeta.startTime = null;
          }
        }

        if (message.value === -1) {
          break;
        }

        if (message.value === 8) {
          for (const valve of this.zoneValves.values()) {
            valve.updateCharacteristic(Characteristic.InUse, 1);
            valve.updateCharacteristic(Characteristic.Active, 1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const meta = (valve as any).__zoneMeta;
            if (meta) {
              meta.startTime = now;
            }
          }
        } else {
          const valve = this.zoneValves.get(message.value);
          if (valve) {
            valve.updateCharacteristic(Characteristic.InUse, 1);
            valve.updateCharacteristic(Characteristic.Active, 1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const meta = (valve as any).__zoneMeta;
            if (meta) {
              meta.startTime = now;
              valve.updateCharacteristic(Characteristic.RemainingDuration, meta.duration);
            }
          }
        }
        break;
      }

      default:
        this.platform.log.debug(`[${this.device.name}] Unhandled irrigation state: ${message.state}`);
    }

    this.platform.log.debug(`[${this.device.name}] State update: ${message.state} = ${message.value}`);
  }

  private setupZones(zones: ZoneDefinition[]): void {
    const { Characteristic, Service } = this.platform;

    zones.forEach((zone) => {
      const rawName = zone.name || `Zone #${zone.id + 1}`;
      const safeName = this.platform.sanitizeName(rawName);
      const subtype = `zone-${zone.id}`;

      const valveService =
        this.accessory.getServiceById(Service.Valve, subtype) ||
        this.accessory.addService(Service.Valve, rawName, subtype);

      valveService.setCharacteristic(Characteristic.Name, rawName);
      valveService.setCharacteristic(Characteristic.ConfiguredName, safeName);
      valveService.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
      valveService.setCharacteristic(Characteristic.Active, 0);
      valveService.setCharacteristic(Characteristic.InUse, 0);
      valveService.setCharacteristic(Characteristic.SetDuration, zone.duration);
      valveService.setCharacteristic(Characteristic.RemainingDuration, 0);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (valveService as any).__zoneMeta = {
        id: zone.id,
        duration: zone.duration,
        startTime: null,
      };

      valveService
        .getCharacteristic(Characteristic.Active)
        .removeAllListeners('set')
        .on('set', (value, callback) => {
          const loxoneZoneId = zone.id + 1;
          if (value === 1) {
            this.sendCommand(`select/${loxoneZoneId}`);
          } else {
            this.sendCommand('select/0');
          }
          callback(null);
        });

      this.zoneValves.set(zone.id, valveService);
    });
  }

  private startRemainingDurationUpdater(): void {
    if (this.durationUpdateInterval) {
      return;
    }

    this.durationUpdateInterval = setInterval(() => {
      const now = Date.now();
      for (const valve of this.zoneValves.values()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const meta = (valve as any).__zoneMeta;
        if (meta?.startTime) {
          const elapsed = Math.floor((now - meta.startTime) / 1000);
          const remaining = Math.max(0, meta.duration - elapsed);
          valve.updateCharacteristic(this.platform.Characteristic.RemainingDuration, remaining);

          if (remaining === 0) {
            meta.startTime = null;
            valve.updateCharacteristic(this.platform.Characteristic.InUse, 0);
            valve.updateCharacteristic(this.platform.Characteristic.Active, 0);
          }
        }
      }
    }, 1000);
  }

  private sendCommand(command: string): void {
    this.platform.log.debug(`[${this.device.name}] Sending command to Loxone: ${command}`);
    this.platform.LoxoneHandler.sendCommand(this.device.uuidAction, command);
  }
}