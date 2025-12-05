package net.massa.gossip;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin for writing data to BackgroundRunner's storage.
 * 
 * This bridges the gap between main app storage (CapacitorStorage) and
 * BackgroundRunner storage (net.massa.gossip.background.sync).
 * 
 * The BackgroundRunner uses a separate SharedPreferences file, so data
 * written by @capacitor/preferences is not visible to it.
 * 
 * This plugin allows any native service to write data that needs to be
 * accessed by the BackgroundRunner (e.g., seekers, timestamps, API URLs).
 */
@CapacitorPlugin(name = "BackgroundRunnerStorage")
public class BackgroundRunnerStoragePlugin extends Plugin {
    
    private static final String TAG = "BackgroundRunnerStorage";
    
    // BackgroundRunner storage name - must match the label in capacitor.config.ts
    // The BackgroundRunner uses this as the SharedPreferences file name
    private static final String BACKGROUND_RUNNER_STORAGE = "net.massa.gossip.background.sync";
    
    /**
     * Write a key-value pair to the BackgroundRunner's storage.
     * This bridges the gap between main app storage (CapacitorStorage) and
     * BackgroundRunner storage (net.massa.gossip.background.sync).
     * 
     * The BackgroundRunner uses a separate SharedPreferences file, so data
     * written by @capacitor/preferences is not visible to it.
     */
    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        
        if (key == null) {
            call.reject("Key is required");
            return;
        }
        
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(
                    BACKGROUND_RUNNER_STORAGE, Context.MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();
            
            if (value != null) {
                editor.putString(key, value);
            } else {
                editor.remove(key);
            }
            
            editor.apply();
            
            Log.d(TAG, "Stored to BackgroundRunner storage: " + key);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to write to BackgroundRunner storage", e);
            call.reject("Failed to write to BackgroundRunner storage", e);
        }
    }
}

