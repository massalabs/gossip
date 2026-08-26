package net.massa.gossip;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Bounded SAF transport. JavaScript receives only random process-independent tokens, never URIs. */
@CapacitorPlugin(name = "PortableBackupFile")
public class PortableBackupFilePlugin extends Plugin {
    private static final int MAX_CHUNK = 256 * 1024;
    private static final long MAX_BACKUP_BYTES = 64L * 1024 * 1024 * 1024;
    private static final int MAX_BASE64 = ((MAX_CHUNK + 2) / 3) * 4;
    private static final String PREFS = "PortableBackupPendingOutputs";
    private static final String INDEX = "tokens";
    private static final int URI_FLAGS =
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private static final int READ_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION;

    private static final class Access {
        final Uri uri;
        final int flags;
        final String name;
        FileOutputStream output;
        FileInputStream input;
        long written;
        boolean unverified;
        final boolean source;
        final long totalBytes;

        Access(Uri uri, int flags, String name, boolean unverified) {
            this(uri, flags, name, unverified, false, -1);
        }

        Access(Uri uri, int flags, String name, boolean unverified, boolean source, long totalBytes) {
            this.uri = uri;
            this.flags = flags;
            this.name = name;
            this.unverified = unverified;
            this.source = source;
            this.totalBytes = totalBytes;
        }
    }

    private final Map<String, Access> access = new HashMap<>();
    private boolean pickerPending;
    private boolean destroyed;

    @Override
    public synchronized void load() {
        destroyed = false;
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> tokens = prefs.getStringSet(INDEX, Collections.emptySet());
        for (String token : tokens) {
            String rawUri = prefs.getString(token + ":uri", null);
            if (rawUri == null) continue;
            int flags = prefs.getInt(token + ":flags", 0);
            String name = prefs.getString(token + ":name", "gossip-backup.gossipbackup");
            boolean unverified = prefs.getBoolean(token + ":unverified", true);
            Access state = new Access(Uri.parse(rawUri), flags, name, unverified);
            access.put(token, state);
            if (!unverified) terminalize(token, state);
        }
    }

    @PluginMethod
    public synchronized void selectExportDestination(PluginCall call) {
        if (destroyed) {
            call.reject("Backup transport is unavailable", "DESTROYED");
            return;
        }
        if (pickerPending) {
            call.reject("Backup destination selection is already active", "PICKER_ACTIVE");
            return;
        }
        pickerPending = true;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.putExtra(Intent.EXTRA_TITLE, "gossip-backup.gossipbackup");
        intent.addFlags(URI_FLAGS | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "exportDestinationSelected");
    }

    @PluginMethod
    public synchronized void selectImportSource(PluginCall call) {
        if (destroyed) {
            call.reject("Backup transport is unavailable", "DESTROYED");
            return;
        }
        if (pickerPending) {
            call.reject("Backup source selection is already active", "PICKER_ACTIVE");
            return;
        }
        pickerPending = true;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.addFlags(READ_FLAGS);
        startActivityForResult(call, intent, "importSourceSelected");
    }

    @ActivityCallback
    private synchronized void importSourceSelected(PluginCall call, ActivityResult result) {
        pickerPending = false;
        if (call == null) return;
        Intent data = result == null ? null : result.getData();
        Uri uri = data == null ? null : data.getData();
        if (result == null || result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.reject("Backup source selection cancelled", "CANCELLED");
            return;
        }
        int flags = data.getFlags() & READ_FLAGS;
        long totalBytes = sourceLength(uri);
        if (totalBytes < 0 || totalBytes > MAX_BACKUP_BYTES) {
            releaseGrant(new Access(uri, flags, displayName(uri), false, true, totalBytes));
            call.reject("Backup source size is unavailable", "INVALID_SOURCE");
            return;
        }
        String token = UUID.randomUUID().toString();
        Access state = new Access(uri, flags, displayName(uri), false, true, totalBytes);
        if (destroyed) {
            releaseGrant(state);
            call.reject("Backup transport is unavailable", "DESTROYED");
            return;
        }
        access.put(token, state);
        call.resolve(new JSObject().put("token", token).put("name", state.name)
                .put("totalBytes", state.totalBytes));
    }

    @ActivityCallback
    private synchronized void exportDestinationSelected(PluginCall call, ActivityResult result) {
        pickerPending = false;
        if (call == null) return;
        Intent data = result == null ? null : result.getData();
        Uri uri = data == null ? null : data.getData();
        if (result == null || result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.reject("Backup destination selection cancelled", "CANCELLED");
            return;
        }
        int flags = data.getFlags() & URI_FLAGS;
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (SecurityException ignored) {
            // The provider may grant only process-lifetime access. Operations still fail safely.
        }
        String token = UUID.randomUUID().toString();
        Access state = new Access(uri, flags, displayName(uri), true);
        if (destroyed) {
            releaseGrant(state);
            call.reject("Backup transport is unavailable", "DESTROYED");
            return;
        }
        access.put(token, state);
        if (!persist(token, state)) {
            access.remove(token);
            try { resolver().delete(uri, null, null); } catch (Exception ignored) {}
            releaseGrant(state);
            call.reject("Unable to retain backup destination access", "JOURNAL_FAILED");
            return;
        }
        call.resolve(new JSObject().put("token", token).put("name", state.name));
    }

    @PluginMethod
    public synchronized void readImportChunk(PluginCall call) {
        Access state = requireAccess(call);
        if (state == null) return;
        Integer requested = call.getInt("maxBytes", MAX_CHUNK);
        int maxBytes = requested == null ? MAX_CHUNK : requested;
        if (!state.source || maxBytes <= 0 || maxBytes > MAX_CHUNK) {
            call.reject("Invalid import source state", "NOT_OPEN");
            return;
        }
        byte[] bytes = new byte[maxBytes];
        try {
            if (state.input == null) {
                ParcelFileDescriptor descriptor = resolver().openFileDescriptor(state.uri, "r");
                if (descriptor == null) throw new IllegalStateException("provider returned no descriptor");
                state.input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
                state.written = 0;
            }
            int count = state.input.read(bytes);
            if (count < 0) {
                call.resolve(new JSObject().put("data", JSObject.NULL));
                return;
            }
            state.written = Math.addExact(state.written, count);
            if (state.written > state.totalBytes) throw new IllegalStateException("source grew");
            call.resolve(new JSObject().put(
                    "data", Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP)));
        } catch (Exception error) {
            call.reject("Unable to read backup source", "IMPORT_READ_FAILED", error);
        } finally {
            java.util.Arrays.fill(bytes, (byte) 0);
        }
    }

    @PluginMethod
    public synchronized void finishImportSource(PluginCall call) {
        String token = call.getString("token");
        Access state = token == null ? null : access.get(token);
        if (state == null) {
            call.resolve();
            return;
        }
        if (!state.source) {
            call.reject("Backup access token has the wrong purpose", "INVALID_TOKEN");
            return;
        }
        closeStreams(state);
        access.remove(token);
        releaseGrant(state);
        call.resolve();
    }

    @PluginMethod
    public synchronized void beginExport(PluginCall call) {
        Access state = requireOutputAccess(call);
        if (state == null) return;
        closeStreams(state);
        state.unverified = true;
        if (!persist(call.getString("token"), state)) {
            call.reject("Unable to retain backup recovery state", "JOURNAL_FAILED");
            return;
        }
        try {
            ParcelFileDescriptor descriptor = resolver().openFileDescriptor(state.uri, "rwt");
            if (descriptor == null) throw new IllegalStateException("provider returned no descriptor");
            state.output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor);
            state.written = 0;
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to open backup destination", "OPEN_FAILED", error);
        }
    }

    @PluginMethod
    public synchronized void writeExportChunk(PluginCall call) {
        Access state = requireOutputAccess(call);
        if (state == null) return;
        String encoded = call.getString("data");
        if (encoded == null || encoded.length() == 0 || encoded.length() > MAX_BASE64) {
            call.reject("Invalid backup chunk size", "INVALID_CHUNK");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(encoded, Base64.NO_WRAP);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid backup bytes", "INVALID_CHUNK", error);
            return;
        }
        try {
            if (bytes.length == 0 || bytes.length > MAX_CHUNK) {
                call.reject("Invalid backup chunk size", "INVALID_CHUNK");
                return;
            }
            if (state.output == null) {
                call.reject("Backup destination is not open", "NOT_OPEN");
                return;
            }
            long nextLength = Math.addExact(state.written, bytes.length);
            if (nextLength > MAX_BACKUP_BYTES) {
                call.reject("Backup exceeds maximum size", "BACKUP_TOO_LARGE");
                return;
            }
            state.output.write(bytes);
            state.written = nextLength;
            call.resolve(new JSObject().put("writtenBytes", state.written));
        } catch (Exception error) {
            call.reject("Unable to write backup", "WRITE_FAILED", error);
        } finally {
            java.util.Arrays.fill(bytes, (byte) 0);
        }
    }

    @PluginMethod
    public synchronized void finishExport(PluginCall call) {
        Access state = requireOutputAccess(call);
        if (state == null) return;
        FileOutputStream output = state.output;
        if (output == null) {
            call.reject("Backup destination is not open", "NOT_OPEN");
            return;
        }
        Exception failure = null;
        try {
            output.flush();
            output.getFD().sync();
        } catch (Exception error) {
            failure = error;
        } finally {
            try { output.close(); } catch (Exception closeError) { if (failure == null) failure = closeError; }
            state.output = null;
        }
        if (failure == null) {
            call.resolve(new JSObject().put("writtenBytes", state.written));
        } else {
            call.reject("Unable to finish backup", "WRITE_FAILED", failure);
        }
    }

    @PluginMethod
    public synchronized void beginVerification(PluginCall call) {
        Access state = requireOutputAccess(call);
        if (state == null) return;
        closeInput(state);
        try {
            ParcelFileDescriptor descriptor = resolver().openFileDescriptor(state.uri, "r");
            if (descriptor == null) throw new IllegalStateException("provider returned no descriptor");
            state.input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to verify backup", "VERIFY_OPEN_FAILED", error);
        }
    }

    @PluginMethod
    public synchronized void readVerificationChunk(PluginCall call) {
        Access state = requireOutputAccess(call);
        if (state == null) return;
        Integer requested = call.getInt("maxBytes", MAX_CHUNK);
        int maxBytes = requested == null ? MAX_CHUNK : requested;
        if (maxBytes <= 0 || maxBytes > MAX_CHUNK || state.input == null) {
            call.reject("Invalid verification state", "NOT_OPEN");
            return;
        }
        byte[] bytes = new byte[maxBytes];
        try {
            int count = state.input.read(bytes);
            String encoded = count < 0 ? null : Base64.encodeToString(bytes, 0, count, Base64.NO_WRAP);
            call.resolve(new JSObject().put("data", encoded == null ? JSObject.NULL : encoded));
        } catch (Exception error) {
            call.reject("Unable to verify backup", "VERIFY_READ_FAILED", error);
        } finally {
            java.util.Arrays.fill(bytes, (byte) 0);
        }
    }

    @PluginMethod
    public synchronized void finishVerification(PluginCall call) {
        String token = call.getString("token");
        Access state = token == null ? null : access.get(token);
        if (state == null || state.source) {
            call.reject("Backup access token expired", "INVALID_TOKEN");
            return;
        }
        closeStreams(state);
        if (!terminalize(token, state)) {
            call.reject("Unable to finalize backup recovery state", "JOURNAL_FAILED");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public synchronized void listInterruptedOutputs(PluginCall call) {
        JSArray outputs = new JSArray();
        for (Map.Entry<String, Access> entry : access.entrySet()) {
            if (!entry.getValue().unverified) continue;
            outputs.put(new JSObject().put("token", entry.getKey()).put("name", entry.getValue().name));
        }
        call.resolve(new JSObject().put("outputs", outputs));
    }

    @PluginMethod
    public synchronized void deleteOutput(PluginCall call) {
        String token = call.getString("token");
        Access state = token == null ? null : access.get(token);
        if (state == null || state.source) {
            call.resolve(new JSObject().put("deleted", false));
            return;
        }
        closeStreams(state);
        boolean cleaned = false;
        try { cleaned = resolver().delete(state.uri, null, null) > 0; } catch (Exception ignored) {}
        if (!cleaned) {
            try (ParcelFileDescriptor descriptor = resolver().openFileDescriptor(state.uri, "rwt")) {
                if (descriptor != null) {
                    try (FileOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
                        output.flush();
                        output.getFD().sync();
                    }
                    cleaned = true;
                }
            } catch (Exception ignored) {}
        }
        if (cleaned) cleaned = terminalize(token, state);
        call.resolve(new JSObject().put("deleted", cleaned));
    }

    @PluginMethod
    public synchronized void forgetOutput(PluginCall call) {
        String token = call.getString("token");
        Access state = token == null ? null : access.get(token);
        if (state == null) {
            call.resolve();
            return;
        }
        if (state.source) {
            call.reject("Backup access token has the wrong purpose", "INVALID_TOKEN");
            return;
        }
        closeStreams(state);
        if (!terminalize(token, state)) {
            call.reject("Unable to forget backup recovery state", "JOURNAL_FAILED");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public synchronized void abandon(PluginCall call) {
        deleteOutput(call);
    }

    @PluginMethod
    public synchronized void startProtection(PluginCall call) {
        Intent intent = PortableBackupForegroundService.startIntent(
                getContext(),
                call.getString("title", getContext().getString(R.string.portable_backup_notification_title)),
                call.getString("text", getContext().getString(R.string.portable_backup_notification_preparing)));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to protect backup", "PROTECTION_FAILED", error);
        }
    }

    @PluginMethod
    public synchronized void updateProtection(PluginCall call) {
        Intent intent = PortableBackupForegroundService.progressIntent(
                getContext(),
                call.getString("text", getContext().getString(R.string.portable_backup_notification_writing)),
                call.getData().optLong("processedBytes", 0L),
                call.getData().optLong("totalBytes", 0L));
        try {
            getContext().startService(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to update backup protection", "PROTECTION_FAILED", error);
        }
    }

    @PluginMethod
    public synchronized void stopProtection(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PortableBackupForegroundService.class));
        call.resolve();
    }

    @Override
    protected synchronized void handleOnDestroy() {
        destroyed = true;
        pickerPending = false;
        for (Access state : access.values()) {
            closeStreams(state);
            if (state.source) releaseGrant(state);
        }
        access.clear();
        getContext().stopService(new Intent(getContext(), PortableBackupForegroundService.class));
        super.handleOnDestroy();
    }

    private Access requireAccess(PluginCall call) {
        String token = call.getString("token");
        Access state = token == null ? null : access.get(token);
        if (state == null) call.reject("Backup access token expired", "INVALID_TOKEN");
        return state;
    }

    private Access requireOutputAccess(PluginCall call) {
        Access state = requireAccess(call);
        if (state != null && state.source) {
            call.reject("Backup access token has the wrong purpose", "INVALID_TOKEN");
            return null;
        }
        return state;
    }

    private ContentResolver resolver() { return getContext().getContentResolver(); }

    private long sourceLength(Uri uri) {
        try (ParcelFileDescriptor descriptor = resolver().openFileDescriptor(uri, "r")) {
            if (descriptor != null && descriptor.getStatSize() >= 0) return descriptor.getStatSize();
        } catch (Exception ignored) {}
        try (android.database.Cursor cursor = resolver().query(
                uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index);
            }
        } catch (Exception ignored) {}
        return -1;
    }

    private String displayName(Uri uri) {
        try (android.database.Cursor cursor = resolver().query(
                uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.trim().isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {}
        return "gossip-backup.gossipbackup";
    }

    private void closeInput(Access state) {
        try { if (state.input != null) state.input.close(); } catch (Exception ignored) {}
        state.input = null;
    }

    private void closeStreams(Access state) {
        try { if (state.output != null) state.output.close(); } catch (Exception ignored) {}
        state.output = null;
        closeInput(state);
    }

    private boolean persist(String token, Access state) {
        if (token == null) return false;
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> tokens = new HashSet<>(
                prefs.getStringSet(INDEX, Collections.emptySet()));
        tokens.add(token);
        return prefs.edit().putStringSet(INDEX, tokens)
                .putString(token + ":uri", state.uri.toString())
                .putInt(token + ":flags", state.flags)
                .putString(token + ":name", state.name)
                .putBoolean(token + ":unverified", state.unverified).commit();
    }

    private boolean terminalize(String token, Access state) {
        state.unverified = false;
        if (!persist(token, state)) {
            state.unverified = true;
            return false;
        }
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> tokens = new HashSet<>(
                prefs.getStringSet(INDEX, Collections.emptySet()));
        tokens.remove(token);
        boolean removed = prefs.edit().putStringSet(INDEX, tokens)
                .remove(token + ":uri").remove(token + ":flags")
                .remove(token + ":name").remove(token + ":unverified").commit();
        if (removed) {
            access.remove(token);
            releaseGrant(state);
        }
        // A failed removal leaves a durable verified marker. load() ignores it,
        // so it can never be mistaken for an interrupted output and deleted.
        return true;
    }

    private void releaseGrant(Access state) {
        if (state.flags == 0) return;
        try { resolver().releasePersistableUriPermission(state.uri, state.flags); }
        catch (Exception ignored) {}
    }
}
