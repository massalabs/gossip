package net.massa.gossip;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin for checking and managing battery optimization settings.
 * This is critical for reliable background sync on Android devices.
 */
@CapacitorPlugin(name = "BatteryOptimization")
public class BatteryOptimizationPlugin extends Plugin {

    /**
     * Check if the app is ignoring battery optimizations.
     * Returns true if the app is whitelisted (exempt from Doze mode).
     */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        try {
            Context context = getContext();
            PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            
            // Early return if PowerManager is unavailable
            if (powerManager == null) {
                JSObject result = new JSObject();
                result.put("isIgnoring", false);
                call.resolve(result);
                return;
            }
            
            boolean isIgnoring = powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
            
            JSObject result = new JSObject();
            result.put("isIgnoring", isIgnoring);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to check battery optimization status", e);
        }
    }

    /**
     * Check if background activity is restricted (API 28+).
     * Returns true if the system restricts the app's background activity.
     */
    @PluginMethod
    public void isBackgroundRestricted(PluginCall call) {
        try {
            boolean isRestricted = false;
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                isRestricted = checkBackgroundRestriction(getContext());
            }
            
            JSObject result = new JSObject();
            result.put("isRestricted", isRestricted);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to check background restriction status", e);
        }
    }

    /**
     * Open the battery optimization settings for this app.
     * This allows the user to disable battery optimization.
     */
    @PluginMethod
    public void openBatteryOptimizationSettings(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent();
            intent.setAction(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            
            call.resolve();
        } catch (Exception e) {
            // Fallback to general battery settings if the direct intent fails
            try {
                Intent fallbackIntent = new Intent();
                fallbackIntent.setAction(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallbackIntent);
                call.resolve();
            } catch (Exception e2) {
                call.reject("Failed to open battery optimization settings", e2);
            }
        }
    }

    /**
     * Open the app's detailed settings page.
     * This is a fallback for when battery optimization intent is not available.
     */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent();
            intent.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open app settings", e);
        }
    }

    /**
     * Get the device manufacturer name.
     */
    @PluginMethod
    public void getManufacturer(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("manufacturer", Build.MANUFACTURER.toLowerCase());
            result.put("brand", Build.BRAND.toLowerCase());
            result.put("model", Build.MODEL);
            result.put("device", Build.DEVICE);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to get manufacturer info", e);
        }
    }

    /**
     * Check if this is a Xiaomi/MIUI device.
     * These devices require special handling for background processes.
     */
    @PluginMethod
    public void isXiaomiDevice(PluginCall call) {
        try {
            String manufacturer = Build.MANUFACTURER.toLowerCase();
            String brand = Build.BRAND.toLowerCase();
            
            boolean isXiaomi = manufacturer.contains("xiaomi") 
                || manufacturer.contains("redmi") 
                || manufacturer.contains("poco")
                || brand.contains("xiaomi")
                || brand.contains("redmi")
                || brand.contains("poco");
            
            JSObject result = new JSObject();
            result.put("isXiaomi", isXiaomi);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to check Xiaomi device", e);
        }
    }

    /**
     * Try to open Xiaomi's AutoStart settings.
     * This is only available on MIUI devices.
     */
    @PluginMethod
    public void openXiaomiAutoStartSettings(PluginCall call) {
        try {
            Intent intent = new Intent();
            intent.setClassName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity"
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            // AutoStart settings not available (not a MIUI device)
            call.reject("AutoStart settings not available on this device", e);
        }
    }

    /**
     * Get comprehensive background sync status.
     * Returns all relevant information for diagnosing background sync issues.
     */
    @PluginMethod
    public void getBackgroundSyncStatus(PluginCall call) {
        try {
            Context context = getContext();
            
            // Check battery optimization
            PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            boolean isIgnoringBatteryOptimization = powerManager != null 
                && powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
            
            // Check background restriction (API 28+)
            boolean isBackgroundRestricted = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                isBackgroundRestricted = checkBackgroundRestriction(context);
            }
            
            // Get device info
            String manufacturer = Build.MANUFACTURER.toLowerCase();
            String brand = Build.BRAND.toLowerCase();
            
            // Check if problematic manufacturer
            boolean isProblematicDevice = isProblematicManufacturer(manufacturer) 
                || isProblematicManufacturer(brand);
            
            JSObject result = new JSObject();
            result.put("isIgnoringBatteryOptimization", isIgnoringBatteryOptimization);
            result.put("isBackgroundRestricted", isBackgroundRestricted);
            result.put("isProblematicDevice", isProblematicDevice);
            result.put("manufacturer", manufacturer);
            result.put("brand", brand);
            result.put("model", Build.MODEL);
            result.put("sdkVersion", Build.VERSION.SDK_INT);
            
            // Overall status: background sync is likely reliable if:
            // - Battery optimization is disabled (ignoring)
            // - Background is not restricted
            boolean isBackgroundSyncReliable = isIgnoringBatteryOptimization && !isBackgroundRestricted;
            result.put("isBackgroundSyncReliable", isBackgroundSyncReliable);
            
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to get background sync status", e);
        }
    }

    /**
     * Check if background activity is restricted (API 28+).
     * @param context The application context
     * @return true if background activity is restricted, false otherwise
     */
    @RequiresApi(Build.VERSION_CODES.P)
    private boolean checkBackgroundRestriction(Context context) {
        ActivityManager activityManager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (activityManager != null) {
            return activityManager.isBackgroundRestricted();
        }
        return false;
    }

    /**
     * Check if the manufacturer is known to have problematic battery optimization.
     */
    private boolean isProblematicManufacturer(String name) {
        if (name == null) return false;
        
        String[] problematicManufacturers = {
            "xiaomi", "redmi", "poco",  // Xiaomi family
            "huawei", "honor",           // Huawei family
            "oppo", "realme", "oneplus", "vivo",  // BBK Electronics
            "samsung",                   // Samsung
            "meizu", "asus", "lenovo",   // Others
            "tecno", "infinix", "itel"   // Transsion
        };
        
        for (String manufacturer : problematicManufacturers) {
            if (name.contains(manufacturer)) {
                return true;
            }
        }
        
        return false;
    }
}

