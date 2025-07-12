import { LoxoneAccessory } from '../../LoxoneAccessory';
import { IrrigationSystem } from '../../homekit/services/IrrigationSystem';

/**
 * Loxone Irrigation Item
 */
export class Irrigation extends LoxoneAccessory {

  configureServices(): void {
    // Define the item states and their corresponding services
    this.ItemStates = {
      [this.device.states.rainActive]: {'service': 'PrimaryService', 'state': 'rainActive'},
      [this.device.states.zones]: {'service': 'PrimaryService', 'state': 'zones'},
      [this.device.states.currentZone]: {'service': 'PrimaryService', 'state': 'currentZone'},
    };

    // Create the Irrigation System service and assign it to the PrimaryService
    this.Service.PrimaryService = new IrrigationSystem(this.platform, this.Accessory!);
  }
}
