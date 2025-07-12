import { BaseService } from './BaseService';
import { Service } from 'homebridge';

interface ZoneDefinition {
  id: number;
  name: string;
  duration: number;
  setByLogic?: boolean;
}

/**
 * HomeKit Irrigation System with dynamic Valve zones and Loxone command integration.
 */
export class IrrigationSystem extends BaseService {
  private zoneValves: Map<number, Service> = new Map();

  /**
   * Set up the main IrrigationSystem service (invisible in Home app but required).
   */
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

  /**
   * Handle incoming state updates from Loxone.
   */
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
          this.setupZones(zones);
        } catch (err) {
          this.platform.log.warn(`[${this.device.name}] Invalid zone data: ${message.value}`);
        }
        break;
      }

      case 'currentZone': {
        // Reset all zones first
        for (const valve of this.zoneValves.values()) {
          valve.updateCharacteristic(Characteristic.InUse, 0);
          valve.updateCharacteristic(Characteristic.Active, 0);
        }

        if (message.value === -1) {
          this.platform.log.debug(`[${this.device.name}] All zones off`);
          break;
        }

        if (message.value === 8) {
          this.platform.log.debug(`[${this.device.name}] All zones active`);
          for (const valve of this.zoneValves.values()) {
            valve.updateCharacteristic(Characteristic.InUse, 1);
            valve.updateCharacteristic(Characteristic.Active, 1);
          }
        } else {
          const activeValve = this.zoneValves.get(message.value);
          if (activeValve) {
            this.platform.log.debug(`[${this.device.name}] Zone ${message.value} is active`);
            activeValve.updateCharacteristic(Characteristic.InUse, 1);
            activeValve.updateCharacteristic(Characteristic.Active, 1);
          } else {
            this.platform.log.warn(`[${this.device.name}] Unknown zone index: ${message.value}`);
          }
        }
        break;
      }

      default:
        this.platform.log.debug(`[${this.device.name}] Unhandled irrigation state: ${message.state}`);
    }

    this.platform.log.debug(`[${this.device.name}] State update: ${message.state} = ${message.value}`);
  }

  /**
   * Create or update HomeKit Valve services dynamically for each irrigation zone.
   */
  private setupZones(zones: ZoneDefinition[]): void {
    const { Characteristic, Service } = this.platform;

    zones.forEach((zone) => {
      const displayName = zone.name;

      const valveService =
        this.accessory.getServiceById(Service.Valve, `zone-${zone.id}`) ||
        this.accessory.addService(Service.Valve, displayName, `zone-${zone.id}`);

      valveService.setCharacteristic(Characteristic.Name, zone.name);
      valveService.setCharacteristic(Characteristic.ConfiguredName, displayName);
      valveService.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
      valveService.setCharacteristic(Characteristic.Active, 0);
      valveService.setCharacteristic(Characteristic.InUse, 0);

      // Register handler once per zone
      if (!this.zoneValves.has(zone.id)) {
        this.platform.log.info(`[${this.device.name}] Registering handler for zone ${zone.id}`);

        valveService.getCharacteristic(Characteristic.Active).on('set', (value, callback) => {
          if (value === 1) {
            this.platform.log.debug(`[${this.device.name}] Activating zone ${zone.id}`);
            this.sendCommand(`select/${zone.id}`);
            valveService.updateCharacteristic(Characteristic.InUse, 1);
          } else {
            this.platform.log.debug(`[${this.device.name}] Deactivating zone ${zone.id}`);
            this.sendCommand('select/0');
            valveService.updateCharacteristic(Characteristic.InUse, 0);
          }
          callback(null);
        });
      }

      this.zoneValves.set(zone.id, valveService);

      this.platform.log.debug(`[${this.device.name}] Zone ${zone.id} (${zone.name}) registered`);
    });
  }

  /**
   * Send a Loxone command using the platform handler.
   */
  private sendCommand(command: string): void {
    this.platform.log.debug(`[${this.device.name}] Sending command: ${command}`);
    this.platform.LoxoneHandler.sendCommand(this.device.uuidAction, command);
  }
}