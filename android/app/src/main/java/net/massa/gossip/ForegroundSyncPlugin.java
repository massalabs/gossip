package net.massa.gossip;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Exposes high-reliability foreground sync (Android) to the WebView.
 */
@CapacitorPlugin(name = "ForegroundSync")
public class ForegroundSyncPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        try {
            GossipForegroundSyncService.start(getContext());
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to start foreground sync", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            GossipForegroundSyncService.stop(getContext());
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to stop foreground sync", e);
        }
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        try {
            boolean enabled = GossipForegroundSyncService.isEnabled(getContext());
            JSObject result = new JSObject();
            result.put("enabled", enabled);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Failed to read foreground sync state", e);
        }
    }

    @PluginMethod
    public void setSyncPreset(PluginCall call) {
        try {
            String preset = call.getString("preset", "balanced");
            GossipForegroundSyncService.setSyncPreset(getContext(), preset);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to set sync preset", e);
        }
    }
}
