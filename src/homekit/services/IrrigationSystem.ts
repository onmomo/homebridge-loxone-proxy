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
   * Set up the main IrrigationSystem service (hidden in Home app).
   */
  setupService(): void {
    this.service =
      this.accessory.getService(this.platform.Service.IrrigationSystem) ||
      this.accessory.addService(this.platform.Service.IrrigationSystem);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);
    this.service.setCharacteristic(
      this.platform.Characteristic.ProgramMode,
      this.platform.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED
    );
    this.service.setCharacteristic(this.platform.Characteristic.InUse, 0);
    this.service.setCharacteristic(this.platform.Characteristic.Active, 0);
  }

  /**
   * Handle incoming state updates from Loxone.
   * These updates sync Loxone status back into HomeKit.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updateService(message: { state: string; value: any }): void {
    const { Characteristic } = this.platform;

    switch (message.state) {
      case 'rainActive':
        // Disable system if rain is detected
        this.service!.updateCharacteristic(
          Characteristic.Active,
          message.value ? Characteristic.Active.INACTIVE : Characteristic.Active.ACTIVE
        );
        break;

      case 'zones':
        try {
          const zones: ZoneDefinition[] = typeof message.value === 'string'
            ? JSON.parse(message.value)
            : message.value;
          this.setupZones(zones);
        } catch (err) {
          this.platform.log.warn(`[${this.device.name}] Invalid zone data: ${message.value}`);
        }
        break;

      case 'currentZone': {
        // Reset all valves first
        for (const valve of this.zoneValves.values()) {
          valve.updateCharacteristic(Characteristic.InUse, 0);
          valve.updateCharacteristic(Characteristic.Active, 0);
        }

        // Activate selected zone if valid
        const activeValve = this.zoneValves.get(message.value);
        if (activeValve) {
          activeValve.updateCharacteristic(Characteristic.InUse, 1);
          activeValve.updateCharacteristic(Characteristic.Active, 1);
        }
        break;
      }

      default:
        this.platform.log.debug(`[${this.device.name}] Unhandled irrigation state: ${message.state}`);
    }

    this.platform.log.debug(`[${this.device.name}] State update: ${message.state} = ${message.value}`);
  }

  /**
   * Dynamically configure Valve services based on received zones.
   * Each zone represents a HomeKit Valve accessory.
   */
  private setupZones(zones: ZoneDefinition[]): void {
    const { Characteristic, Service } = this.platform;

    zones.forEach((zone) => {
      const displayName = zone.setByLogic ? `Auto: ${zone.name}` : zone.name;

      const valveService =
        this.accessory.getServiceById(Service.Valve, `zone-${zone.id}`) ||
        this.accessory.addService(Service.Valve, displayName, `zone-${zone.id}`);

      // Set initial valve characteristics
      valveService.setCharacteristic(Characteristic.Name, zone.name);
      valveService.setCharacteristic(Characteristic.ConfiguredName, displayName);
      valveService.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
      valveService.setCharacteristic(Characteristic.SetDuration, zone.duration);
      valveService.setCharacteristic(Characteristic.RemainingDuration, 0);
      valveService.setCharacteristic(Characteristic.Active, 0);
      valveService.setCharacteristic(Characteristic.InUse, 0);

      // Handle SetDuration updates
      if (zone.setByLogic) {
        valveService.getCharacteristic(Characteristic.SetDuration).setProps({
          minValue: zone.duration,
          maxValue: zone.duration,
        });

        valveService.getCharacteristic(Characteristic.SetDuration).on('set', (value, callback) => {
          this.platform.log.warn(
            `[${this.device.name}] Ignoring manual duration change for zone ${zone.id} (setByLogic)`
          );
          callback(null);
        });
      } else {
        valveService.getCharacteristic(Characteristic.SetDuration).on('set', (value, callback) => {
          this.platform.log.debug(
            `[${this.device.name}] Updating duration for zone ${zone.id}: ${value}s`
          );
          this.sendCommand(`setDuration/${zone.id}=${value}`);
          callback(null);
        });
      }

      // Handle Active state (on/off from HomeKit UI)
      valveService.getCharacteristic(Characteristic.Active).on('set', (value, callback) => {
        if (value === 1) {
          this.platform.log.debug(`[${this.device.name}] Activating zone ${zone.id}`);
          this.sendCommand(`select/${zone.id}`);
        } else {
          this.platform.log.debug(`[${this.device.name}] Deactivating zone ${zone.id}`);
          this.sendCommand('select/0');
        }
        callback(null);
      });

      // Cache the valve service by ID
      this.zoneValves.set(zone.id, valveService);

      this.platform.log.debug(
        `[${this.device.name}] Zone ${zone.id} (${zone.name}) loaded: ${zone.duration}s` +
        `${zone.setByLogic ? ' [setByLogic]' : ''}`
      );
    });
  }

  /**
   * Send a command to the Loxone Miniserver.
   * @param command Command string (e.g., "select/1", "setDuration/0=300")
   */
  private sendCommand(command: string): void {
    this.platform.log.debug(`[${this.device.name}] Sending command: ${command}`);
    this.platform.LoxoneHandler.sendCommand(this.device.uuidAction, command);
  }
}