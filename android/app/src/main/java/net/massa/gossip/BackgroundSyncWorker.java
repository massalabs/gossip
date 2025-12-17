package net.massa.gossip;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ListenableWorker;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/**
 * WorkManager worker for triggering background sync.
 * 
 * This worker schedules the Capacitor BackgroundRunner's RunnerWorker
 * with the correct configuration to execute background-sync.js.
 * 
 * This is used by BootReceiver and AppUpdateReceiver to ensure
 * background sync continues after device restart or app update.
 */
public class BackgroundSyncWorker extends Worker {
    private static final String TAG = "GossipBackgroundSync";
    
    // These must match the config in capacitor.config.ts
    private static final String RUNNER_LABEL = "net.massa.gossip.background.sync";
    private static final String RUNNER_SRC = "runners/background-sync.js";
    private static final String RUNNER_EVENT = "backgroundSync";
    
    // The BackgroundRunner's worker class
    private static final String BACKGROUND_RUNNER_WORKER = "io.ionic.backgroundrunner.plugin.RunnerWorker";

    public BackgroundSyncWorker(
            @NonNull Context context,
            @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            // Schedule the BackgroundRunner's worker to execute the sync
            // The lock will be acquired/released by the BackgroundRunner JavaScript code
            scheduleBackgroundRunnerSync(getApplicationContext());
            return Result.success();
        } catch (Exception e) {
            Log.e(TAG, "BackgroundSyncWorker failed", e);
            return Result.retry();
        }
    }

    /**
     * Schedule the Capacitor BackgroundRunner's RunnerWorker to execute
     * the background-sync.js script.
     * 
     * This uses the same mechanism that BackgroundRunner uses internally,
     * ensuring compatibility with the plugin's execution model.
     * 
     * The lock will be acquired/released by the BackgroundRunner JavaScript code.
     * 
     * @param context The application context
     * @return true if sync was scheduled, false if error occurred
     */
    public static boolean scheduleBackgroundRunnerSync(Context context) {
        try {
            // Build the input data that BackgroundRunner's RunnerWorker expects
            Data inputData = new Data.Builder()
                .putString("label", RUNNER_LABEL)
                .putString("src", RUNNER_SRC)
                .putString("event", RUNNER_EVENT)
                .build();

            // Build constraints - require network connectivity
            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

            // Create a one-time work request to BackgroundRunner's worker
            // We use reflection to get the class to avoid compile-time dependency
            Class<?> runnerWorkerClass;
            try {
                runnerWorkerClass = Class.forName(BACKGROUND_RUNNER_WORKER);
            } catch (ClassNotFoundException e) {
                Log.e(TAG, "BackgroundRunner worker class not found, skipping sync scheduling");
                return false;
            }

            // Runtime type check to ensure the class is compatible with ListenableWorker
            if (!ListenableWorker.class.isAssignableFrom(runnerWorkerClass)) {
                Log.e(TAG, "BackgroundRunner worker class is not a ListenableWorker: " + runnerWorkerClass.getName());
                return false;
            }

            @SuppressWarnings("unchecked")
            OneTimeWorkRequest workRequest = new OneTimeWorkRequest.Builder(
                    (Class<? extends ListenableWorker>) runnerWorkerClass)
                .setInputData(inputData)
                .setConstraints(constraints)
                .addTag(RUNNER_LABEL + ".immediate")
                .build();

            // Enqueue the work request
            WorkManager.getInstance(context).enqueueUniqueWork(
                RUNNER_LABEL + ".immediate",
                ExistingWorkPolicy.REPLACE,
                workRequest
            );

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule BackgroundRunner sync", e);
            return false;
        }
    }

    /**
     * Schedule a delayed background sync.
     * This is useful for scheduling syncs after a short delay (e.g., after boot).
     * 
     * Note: For delayed syncs, we schedule the work but the lock will be checked
     * when the sync actually executes. Since delayed syncs go directly to RunnerWorker,
     * they will execute the JS script which should handle duplicate prevention.
     * 
     * @param context The application context
     * @param delayMinutes The delay in minutes before the sync runs
     */
    public static void scheduleDelayedSync(Context context, int delayMinutes) {
        try {
            Data inputData = new Data.Builder()
                .putString("label", RUNNER_LABEL)
                .putString("src", RUNNER_SRC)
                .putString("event", RUNNER_EVENT)
                .build();

            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

            Class<?> runnerWorkerClass;
            try {
                runnerWorkerClass = Class.forName(BACKGROUND_RUNNER_WORKER);
            } catch (ClassNotFoundException e) {
                Log.e(TAG, "BackgroundRunner worker class not found");
                return;
            }

            // Runtime type check to ensure the class is compatible with ListenableWorker
            if (!ListenableWorker.class.isAssignableFrom(runnerWorkerClass)) {
                Log.e(TAG, "BackgroundRunner worker class is not a ListenableWorker: " + runnerWorkerClass.getName());
                return;
            }

            @SuppressWarnings("unchecked")
            OneTimeWorkRequest workRequest = new OneTimeWorkRequest.Builder(
                    (Class<? extends ListenableWorker>) runnerWorkerClass)
                .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
                .setInputData(inputData)
                .setConstraints(constraints)
                .addTag(RUNNER_LABEL + ".delayed")
                .build();

            WorkManager.getInstance(context).enqueueUniqueWork(
                RUNNER_LABEL + ".delayed",
                ExistingWorkPolicy.REPLACE,
                workRequest
            );

        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule delayed sync", e);
        }
    }
}
