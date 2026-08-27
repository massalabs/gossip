package net.massa.gossip;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import java.util.HashSet;
import java.util.Set;

import io.ionic.backgroundrunner.plugin.api.TimedNotificationPublisher;

import com.getcapacitor.JSObject;
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
    private static final Object ACCOUNT_OUTPUT_MONITOR =
            "gossip-account-output-monitor-v1".intern();
    
    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("Key is required");
            return;
        }
        SharedPreferences prefs = getContext().getSharedPreferences(
                BACKGROUND_RUNNER_STORAGE, Context.MODE_PRIVATE);
        JSObject result = new JSObject();
        String value = prefs.getString(key, null);
        if (value != null) {
            result.put("value", value);
        }
        call.resolve(result);
    }

    @PluginMethod
    public void cancelNotifications(PluginCall call) {
        synchronized (ACCOUNT_OUTPUT_MONITOR) {
            SharedPreferences prefs = getContext().getSharedPreferences(
                    BACKGROUND_RUNNER_STORAGE, Context.MODE_PRIVATE);
            Set<String> ids = new HashSet<>(prefs.getStringSet(
                    "gossip-runner-notification-ids", new HashSet<>()));
            AlarmManager alarms = (AlarmManager) getContext().getSystemService(
                    Context.ALARM_SERVICE);
            for (String rawId : ids) {
                try {
                    int id = Integer.parseInt(rawId);
                    Intent intent = new Intent(getContext(), TimedNotificationPublisher.class);
                    int flags = PendingIntent.FLAG_NO_CREATE;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        flags |= PendingIntent.FLAG_MUTABLE;
                    }
                    PendingIntent pending = PendingIntent.getBroadcast(
                            getContext(), id, intent, flags);
                    if (pending != null) {
                        alarms.cancel(pending);
                        pending.cancel();
                    }
                } catch (NumberFormatException ignored) {
                    // Invalid registry entries are removed with the registry below.
                }
            }
            if (!prefs.edit().remove("gossip-runner-notification-ids").commit()) {
                call.reject("Failed to clear BackgroundRunner notification registry");
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void clearIfValue(PluginCall call) {
        String key = call.getString("key");
        String expected = call.getString("expected");
        if (key == null || expected == null) {
            call.reject("Key and expected value are required");
            return;
        }
        synchronized (ACCOUNT_OUTPUT_MONITOR) {
            SharedPreferences prefs = getContext().getSharedPreferences(
                    BACKGROUND_RUNNER_STORAGE, Context.MODE_PRIVATE);
            if (expected.equals(prefs.getString(key, null))
                    && !prefs.edit().remove(key).commit()) {
                call.reject("Failed to durably clear BackgroundRunner storage");
                return;
            }
        }
        call.resolve();
    }

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
            String scope = call.getString("scope", "runner");
            String storageName = "app".equals(scope)
                    ? "CapacitorStorage"
                    : BACKGROUND_RUNNER_STORAGE;
            synchronized (ACCOUNT_OUTPUT_MONITOR) {
                SharedPreferences prefs = getContext().getSharedPreferences(
                        storageName, Context.MODE_PRIVATE);
                SharedPreferences.Editor editor = prefs.edit();

                if (value != null) {
                    editor.putString(key, value);
                } else {
                    editor.remove(key);
                }

                boolean strict = Boolean.TRUE.equals(call.getBoolean("strict", false));
                if (strict) {
                    if (!editor.commit()) {
                        call.reject("Failed to durably write BackgroundRunner storage");
                        return;
                    }
                } else {
                    editor.apply();
                }
            }

            Log.d(TAG, "Stored to BackgroundRunner storage: " + key);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to write to BackgroundRunner storage", e);
            call.reject("Failed to write to BackgroundRunner storage", e);
        }
    }
}

