/**
 * Device Info Utilities
 *
 * Provides device detection and information for background sync optimization.
 * Detects problematic manufacturers known to aggressively kill background processes.
 */

import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

/**
 * Xiaomi family manufacturers (MIUI devices).
 * These devices require special handling for background processes.
 */
export const XIAOMI_MANUFACTURERS = ['xiaomi', 'redmi', 'poco'] as const;

/**
 * List of device manufacturers known to have aggressive battery optimization
 * that can interfere with background sync.
 */
export const PROBLEMATIC_MANUFACTURERS = [
  // Xiaomi family (MIUI)
  ...XIAOMI_MANUFACTURERS,
  // Huawei family (EMUI)
  'huawei',
  'honor',
  // BBK Electronics family (ColorOS, OxygenOS, FuntouchOS)
  'oppo',
  'realme',
  'oneplus',
  'vivo',
  // Samsung (One UI)
  'samsung',
  // Others with aggressive optimization
  'meizu',
  'asus',
  'lenovo',
  'tecno',
  'infinix',
  'itel',
] as const;

export type ProblematicManufacturer =
  (typeof PROBLEMATIC_MANUFACTURERS)[number];

export interface DeviceInfo {
  platform: 'ios' | 'android' | 'web';
  manufacturer: string;
  model: string;
  osVersion: string;
  isNative: boolean;
}

export interface DeviceReliabilityInfo {
  manufacturer: string | null;
  isProblematic: boolean;
  requiresBatteryOptimizationBypass: boolean;
  warningMessage: string | null;
  helpUrl: string | null;
}

// Cache for device info to avoid repeated async calls
let cachedDeviceInfo: DeviceInfo | null = null;

/**
 * Get device information using @capacitor/device.
 * Results are cached after the first call.
 */
export async function getDeviceInfo(): Promise<DeviceInfo> {
  if (cachedDeviceInfo) {
    return cachedDeviceInfo;
  }

  const isNative = Capacitor.isNativePlatform();
  const platform = Capacitor.getPlatform() as 'ios' | 'android' | 'web';

  if (!isNative) {
    cachedDeviceInfo = {
      platform: 'web',
      manufacturer: 'unknown',
      model: 'unknown',
      osVersion: 'unknown',
      isNative: false,
    };
    return cachedDeviceInfo;
  }

  try {
    const info = await Device.getInfo();

    cachedDeviceInfo = {
      platform,
      manufacturer: info.manufacturer?.toLowerCase() || 'unknown',
      model: info.model || 'unknown',
      osVersion: info.osVersion || 'unknown',
      isNative: true,
    };
  } catch (error) {
    console.error('Failed to get device info:', error);
    cachedDeviceInfo = {
      platform,
      manufacturer: 'unknown',
      model: 'unknown',
      osVersion: 'unknown',
      isNative: true,
    };
  }

  return cachedDeviceInfo;
}

/**
 * Check if a manufacturer is in the Xiaomi family (Xiaomi, Redmi, POCO).
 * @param manufacturer - The manufacturer name (case-insensitive)
 */
export function isXiaomiManufacturer(manufacturer: string): boolean {
  const normalizedManufacturer = manufacturer.toLowerCase().trim();
  return XIAOMI_MANUFACTURERS.some(
    xiaomi =>
      normalizedManufacturer.includes(xiaomi) ||
      xiaomi.includes(normalizedManufacturer)
  );
}

/**
 * Check if a manufacturer is in the problematic list.
 * @param manufacturer - The manufacturer name (case-insensitive)
 */
export function isProblematicManufacturer(manufacturer: string): boolean {
  const normalizedManufacturer = manufacturer.toLowerCase().trim();
  return PROBLEMATIC_MANUFACTURERS.some(
    problematic =>
      normalizedManufacturer.includes(problematic) ||
      problematic.includes(normalizedManufacturer)
  );
}

/**
 * Find a matching manufacturer key from a map using bidirectional matching.
 * @param normalizedManufacturer - The normalized manufacturer name (lowercase, trimmed)
 * @param matchMap - A record mapping manufacturer keys to values
 * @returns The matching key if found, null otherwise
 */
function findManufacturerMatch(
  normalizedManufacturer: string,
  matchMap: Record<string, string>
): string | null {
  for (const [key] of Object.entries(matchMap)) {
    if (
      normalizedManufacturer.includes(key) ||
      key.includes(normalizedManufacturer)
    ) {
      return key;
    }
  }
  return null;
}

/**
 * Get the help URL for battery optimization settings for a specific manufacturer.
 * Links to dontkillmyapp.com which has device-specific instructions.
 */
export function getBatteryOptimizationHelpUrl(manufacturer: string): string {
  const normalizedManufacturer = manufacturer.toLowerCase().trim();

  // Map manufacturer aliases to their dontkillmyapp.com slug
  const manufacturerToSlug: Record<string, string> = {
    xiaomi: 'xiaomi',
    redmi: 'xiaomi',
    poco: 'xiaomi',
    huawei: 'huawei',
    honor: 'huawei',
    oppo: 'oppo',
    realme: 'realme',
    oneplus: 'oneplus',
    vivo: 'vivo',
    samsung: 'samsung',
    meizu: 'meizu',
    asus: 'asus',
    lenovo: 'lenovo',
    tecno: 'tecno',
    infinix: 'tecno',
    itel: 'tecno',
  };

  // Find matching manufacturer
  const match = findManufacturerMatch(
    normalizedManufacturer,
    manufacturerToSlug
  );
  if (match) {
    return `https://dontkillmyapp.com/${manufacturerToSlug[match]}`;
  }

  // Default to generic Android page
  return 'https://dontkillmyapp.com/';
}

// Warning message constants for manufacturer groups (DRY)
const WARNING_XIAOMI =
  'Xiaomi devices have aggressive battery optimization. To receive messages reliably in the background, please disable battery optimization for Gossip and enable "Autostart" in the MIUI security settings.';
const WARNING_HUAWEI =
  'Huawei devices have strict battery management. To receive messages reliably in the background, please disable battery optimization for Gossip and add it to "Protected Apps" in the battery settings.';
const WARNING_SAMSUNG =
  'Samsung devices may limit background activity. To receive messages reliably, please disable battery optimization and turn off "Put app to sleep" for Gossip.';
const WARNING_ONEPLUS =
  'OnePlus devices have battery optimization that may affect background sync. Please disable battery optimization for Gossip.';
const WARNING_BBK =
  'This device has battery optimization that may prevent background notifications. Please disable battery optimization and allow background activity for Gossip.';
const WARNING_GENERIC =
  'This device may limit background activity. For reliable message notifications, please check your battery optimization settings and allow Gossip to run in the background.';

/**
 * Get a user-friendly warning message for a specific manufacturer.
 */
export function getManufacturerWarningMessage(manufacturer: string): string {
  const normalizedManufacturer = manufacturer.toLowerCase().trim();

  // Map manufacturer groups to their warning messages
  const manufacturerGroups: Record<string, string> = {
    // Xiaomi family (MIUI) - most aggressive
    xiaomi: WARNING_XIAOMI,
    redmi: WARNING_XIAOMI,
    poco: WARNING_XIAOMI,
    // Huawei family (EMUI)
    huawei: WARNING_HUAWEI,
    honor: WARNING_HUAWEI,
    // Samsung (One UI)
    samsung: WARNING_SAMSUNG,
    // OnePlus (OxygenOS)
    oneplus: WARNING_ONEPLUS,
    // BBK Electronics family (OPPO/Realme/Vivo)
    oppo: WARNING_BBK,
    realme: WARNING_BBK,
    vivo: WARNING_BBK,
  };

  // Find matching manufacturer
  const match = findManufacturerMatch(
    normalizedManufacturer,
    manufacturerGroups
  );
  if (match) {
    return manufacturerGroups[match];
  }

  // Generic message for other problematic manufacturers
  return WARNING_GENERIC;
}

/**
 * Get comprehensive device reliability information for background sync.
 */
export async function getDeviceReliabilityInfo(): Promise<DeviceReliabilityInfo> {
  const deviceInfo = await getDeviceInfo();

  // Only relevant for Android
  if (deviceInfo.platform !== 'android') {
    return {
      manufacturer: null,
      isProblematic: false,
      requiresBatteryOptimizationBypass: false,
      warningMessage: null,
      helpUrl: null,
    };
  }

  const isProblematic = isProblematicManufacturer(deviceInfo.manufacturer);

  return {
    manufacturer: deviceInfo.manufacturer,
    isProblematic,
    requiresBatteryOptimizationBypass: isProblematic,
    warningMessage: isProblematic
      ? getManufacturerWarningMessage(deviceInfo.manufacturer)
      : null,
    helpUrl: isProblematic
      ? getBatteryOptimizationHelpUrl(deviceInfo.manufacturer)
      : null,
  };
}

/**
 * Check if the current platform is Android.
 */
export function isAndroid(): boolean {
  return Capacitor.getPlatform() === 'android';
}

/**
 * Check if the current platform is iOS.
 */
export function isIOS(): boolean {
  return Capacitor.getPlatform() === 'ios';
}

/**
 * Check if running on a native platform (iOS or Android).
 */
export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}
