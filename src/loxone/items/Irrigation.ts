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
      [this.device.states.rainActive]: { service: 'PrimaryService', state: 'rainActive' },
      [this.device.states.zones]: { service: 'PrimaryService', state: 'zones' },
      [this.device.states.currentZone]: { service: 'PrimaryService', state: 'currentZone' },
    };

    // Create and assign the IrrigationSystem HomeKit service
    this.Service.PrimaryService = new IrrigationSystem(this.platform, this.Accessory!);

    // Manually push cached zones state to simulate an initial update,
    // since Loxone may not emit it automatically
    this.triggerCachedZonesState();
  }

  /**
   * Manually triggers the callback handler with the cached 'zones' value,
   * if it is available in the platform's LoxoneHandler cache.
   *
   * This ensures the HomeKit IrrigationService receives an initial zones state
   * even if Loxone does not emit a binary event for it on startup.
   */
  private triggerCachedZonesState(): void {
    const uuid = this.device.states.zones;
    const cachedZones = this.platform.LoxoneHandler.getLastCachedValue(uuid);

    if (cachedZones !== undefined) {
      const message = {
        uuid: uuid,
        state: 'zones',
        service: 'PrimaryService',
        value: cachedZones,
      };

      this.platform.log.debug(`[${this.device.name}] Triggering cached zones: ${cachedZones}`);
      this['callBackHandler'](message); // simulate state update
    } else {
      this.platform.log.debug(`[${this.device.name}] No cached zones value to trigger`);
    }
  }
}