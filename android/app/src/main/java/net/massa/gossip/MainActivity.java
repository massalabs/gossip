package net.massa.gossip;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;
import androidx.core.view.WindowCompat;

public class MainActivity extends BridgeActivity {
    // Track the last processed shared content to prevent duplicate processing
    // when handleSharedContent is called from multiple lifecycle methods
    private String lastProcessedSharedText = null;
    
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before calling super.onCreate()
        registerPlugin(BatteryOptimizationPlugin.class);
        registerPlugin(NetworkObserverPlugin.class);
        registerPlugin(BackgroundRunnerStoragePlugin.class);
        
        super.onCreate(savedInstanceState);

        // Set transparent status and navigation bars
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // Set transparent status and navigation bars colors
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        
        // Disable forced contrast (Android 10+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }

        
        // Handle shared content from other apps after bridge is ready
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> {
                handleSharedContent(getIntent());
            });
        }
    }
    
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Clear tracking since this is a new intent (user explicitly shared something new)
        lastProcessedSharedText = null;
        // Handle shared content when app is already running
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> {
                handleSharedContent(intent);
            });
        }
    }
    
    @Override
    public void onResume() {
        super.onResume();
        // Check for shared content when app resumes
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> {
                handleSharedContent(getIntent());
            });
        }
    }
    
    @Override
    public void onDestroy() {
        super.onDestroy();
        // Clear tracking when Activity is destroyed to allow same content to be shared again in new session
        lastProcessedSharedText = null;
    }
    
    /**
     * Handle content shared from other apps via ACTION_SEND intent
     * Converts shared text/URL to gossip:// URL scheme and triggers Capacitor's appUrlOpen event
     * 
     * This method is called from multiple lifecycle methods (onCreate, onNewIntent, onResume),
     * so we track the last processed shared text to prevent duplicate processing.
     */
    private void handleSharedContent(Intent intent) {
        if (intent == null) {
            return;
        }
        
        String action = intent.getAction();
        String type = intent.getType();
        
        // Clear tracking if this is not a share intent (allows same content to be shared again later)
        if (!Intent.ACTION_SEND.equals(action)) {
            lastProcessedSharedText = null;
            return;
        }
        
        // Handle ACTION_SEND for shared text/URLs
        if (type != null && type.startsWith("text/")) {
            String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText == null) {
                sharedText = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            }
            
            if (sharedText != null && !sharedText.trim().isEmpty()) {
                String trimmedText = sharedText.trim();
                
                // Prevent duplicate processing: only process if this is different from the last processed text
                if (trimmedText.equals(lastProcessedSharedText)) {
                    return;
                }
                
                // Mark this text as processed
                lastProcessedSharedText = trimmedText;
                
                // Convert shared content to gossip:// URL for web layer
                String encodedText = Uri.encode(trimmedText);
                String gossipUrl = "gossip://share?text=" + encodedText;
                
                // Store shared content URL in Capacitor Preferences for JavaScript to read
                // JavaScript will check Preferences on mount and when app becomes active
                try {
                    SharedPreferences prefs = getSharedPreferences(
                            "CapacitorStorage", Context.MODE_PRIVATE);
                    prefs.edit().putString("pendingGossipShareUrl", gossipUrl).apply();
                } catch (Exception e) {
                    Log.e("GossipShare", "Failed to store shared content URL", e);
                }
            }
        }
    }
}
