package net.massa.gossip;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before calling super.onCreate()
        registerPlugin(BatteryOptimizationPlugin.class);
        registerPlugin(NetworkObserverPlugin.class);
        registerPlugin(BackgroundRunnerStoragePlugin.class);
        registerPlugin(SyncManager.class);
        
        super.onCreate(savedInstanceState);
    }
}
