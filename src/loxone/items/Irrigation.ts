import { LoxoneAccessory } from '../../LoxoneAccessory';
import { IrrigationSystem } from '../../homekit/services/IrrigationSystem';

/**
 * Represents a Loxone-controlled Irrigation accessory in HomeKit.
 * This class maps the irrigation controller and ensures that the
 * necessary states (rainActive, currentZone, zones) are tracked,
 * and the zones state is manually pushed from cache if Loxone does not emit it.
 */
export class Irrigation extends LoxoneAccessory {
  /**
   * Configures HomeKit services and registers relevant state listeners.
   */
  configureServices(): void {
    // Define which Loxone states to track and which service they belong to
    this.ItemStates = {
      [this.device.states.zones]: { service: 'PrimaryService', state: 'zones' },
      [this.device.states.currentZone]: { service: 'PrimaryService', state: 'currentZone' },
    };

    // Create and assign the IrrigationSystem HomeKit service
    this.Service.PrimaryService = new IrrigationSystem(this.platform, this.Accessory!);

    // Manually push cached zones state to simulate an initial update
    this.platform.LoxoneHandler.pushCachedState(this, this.device.states.zones);
  }
}