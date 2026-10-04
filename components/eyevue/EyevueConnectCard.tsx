import React, { useCallback, useEffect, useState } from "react";
import * as Clipboard from "expo-clipboard";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import {
  AndroidDaemonNative,
  disconnectAndroidEyevue,
  enableAndroidEyevue,
  getAndroidDaemonStatus,
  scanAndroidEyevueDevices,
  type AndroidDaemonStatus,
  type AndroidEyevueDevice,
  getAndroidNativeSpeechStatus,
  getAndroidEyevueDiagnostics,
  type AndroidNativeSpeechStatus,
} from "@/lib/android-daemon-native";
import { deriveEyeVueVoiceReadiness } from "@/lib/eyevue-setup";

type BusyAction = "permission" | "microphone" | "scan" | "connect" | "assistant" | "diagnostics" | null;

export function EyevueConnectCard() {
  const [status, setStatus] = useState<AndroidDaemonStatus | null>(null);
  const [speechStatus, setSpeechStatus] = useState<AndroidNativeSpeechStatus | null>(null);
  const [devices, setDevices] = useState<AndroidEyevueDevice[]>([]);
  const [setupVisible, setSetupVisible] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [next, speech] = await Promise.all([getAndroidDaemonStatus(), getAndroidNativeSpeechStatus().catch(() => null)]);
    setStatus(next);
    setSpeechStatus(speech);
    if (next.eyevueEnabled === true && speech?.microphonePermissionGranted === true) {
      AndroidDaemonNative?.armEyevueWake?.().catch(() => {});
    }
    return next;
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    refresh().catch(() => {});
    const interval = setInterval(() => refresh().catch(() => {}), 5_000);
    const subscription = AppState.addEventListener("change", next => {
      if (next === "active") refresh().catch(() => {});
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [refresh]);

  useEffect(() => {
    if (status?.eyevueEnabled !== true || speechStatus?.microphonePermissionGranted !== true) return;
    AndroidDaemonNative?.armEyevueWake?.().catch(() => {});
  }, [status?.eyevueEnabled, speechStatus?.microphonePermissionGranted]);

  const run = useCallback(async (action: BusyAction, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      await task();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Glasses setup could not continue.");
    } finally {
      setBusy(null);
    }
  }, [busy, refresh]);

  const requestPermission = useCallback(() => run("permission", async () => {
    if (!AndroidDaemonNative?.requestEyevuePermissions) throw new Error("Nearby Devices setup is unavailable in this APK.");
    await AndroidDaemonNative.requestEyevuePermissions();
  }), [run]);

  const requestMicrophone = useCallback(() => run("microphone", async () => {
    if (!AndroidDaemonNative?.requestMicrophonePermission) throw new Error("Microphone setup is unavailable in this APK.");
    await AndroidDaemonNative.requestMicrophonePermission();
  }), [run]);

  const scan = useCallback(() => run("scan", async () => {
    if (status?.eyevuePermissionGranted !== true) {
      if (!AndroidDaemonNative?.requestEyevuePermissions) throw new Error("Nearby Devices setup is unavailable in this APK.");
      await AndroidDaemonNative.requestEyevuePermissions();
      throw new Error("After allowing Nearby Devices, tap Scan again so Jarvis can show the devices around you.");
    }
    setDevices(await scanAndroidEyevueDevices());
  }), [run, status?.eyevuePermissionGranted]);

  const connect = useCallback((device: AndroidEyevueDevice) => run("connect", async () => {
    // Explicitly tear down the current GATT session before switching selections.
    // The native service will otherwise keep the old GATT while persisting the new address.
    if (status?.eyevueConnected === true) await disconnectAndroidEyevue();
    await enableAndroidEyevue(device.address);
  }), [run, status?.eyevueConnected]);

  const chooseAssistant = useCallback(() => run("assistant", async () => {
    if (!AndroidDaemonNative?.openAssistantSettings) throw new Error("Android assistant settings are unavailable in this APK.");
    await AndroidDaemonNative.openAssistantSettings();
  }), [run]);

  if (Platform.OS !== "android" || status?.available === false) return null;

  const connected = status?.eyevueConnected === true;
  const wakeEvents = status?.eyevueWakeEvents ?? 0;
  const microphoneReady = speechStatus?.microphonePermissionGranted === true;
  const recognizerReady = speechStatus?.speechRecognitionAvailable === true;
  const eyeVueVoiceReadiness = deriveEyeVueVoiceReadiness({
    nativeSpeechAvailable: speechStatus?.available,
    speechRecognitionAvailable: speechStatus?.speechRecognitionAvailable,
    wearableAudioAvailable: speechStatus?.wearableAudioAvailable,
    wearableAudioDeviceName: speechStatus?.wearableAudioDeviceName,
    eyevueConnected: connected,
    eyevueDeviceName: status?.eyevueDeviceName,
  });
  const voiceReady = eyeVueVoiceReadiness.ready;
  const copyDiagnostics = useCallback(() => run("diagnostics", async () => {
    const log = await getAndroidEyevueDiagnostics();
    const payload = [
      "EYE VUE diagnostics",
      `Captured: ${new Date().toISOString()}`,
      `Connection: ${status?.eyevueConnected === true ? "connected" : "not connected"}`,
      `Device: ${status?.eyevueDeviceName || "unknown"}`,
      `Microphone permission: ${speechStatus?.microphonePermissionGranted === true ? "granted" : "not granted"}`,
      `Speech recognition: ${speechStatus?.speechRecognitionAvailable === true ? "available" : "unavailable"}`,
      `Wearable audio: ${voiceReady ? "ready" : "not ready"}`,
      "",
      log || "No EYE VUE or wake entries have been recorded yet.",
    ].join("\n");
    await Clipboard.setStringAsync(payload);
  }), [run, speechStatus?.microphonePermissionGranted, speechStatus?.speechRecognitionAvailable, status?.eyevueConnected, status?.eyevueDeviceName, voiceReady]);

  const fullyReady = connected && microphoneReady && recognizerReady && voiceReady && wakeEvents > 0;
  const title = connected ? (status?.eyevueDeviceName || "Smart Glasses") : "Smart Glasses";
  const detail = fullyReady
    ? "Connected · Hey Star reached Jarvis"
    : connected ? "Connected · finish EYE VUE wake test" : "Discover, choose, and pair your glasses";

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${detail}`}
        style={[styles.connectionRow, fullyReady && styles.connectionRowReady]}
        onPress={() => setSetupVisible(true)}
      >
        <View style={[styles.connectionIcon, fullyReady && styles.connectionIconReady]}>
          <Ionicons name="glasses-outline" size={18} color={fullyReady ? Colors.success : Colors.primary} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.connectionTitle}>{title}</Text>
          <Text style={styles.connectionDetail}>{detail}</Text>
        </View>
        <View style={[styles.connectionButton, fullyReady && styles.connectionButtonReady]}>
          <Text style={[styles.connectionButtonText, fullyReady && styles.connectionButtonTextReady]}>
            {fullyReady ? "Connected" : connected ? "Finish" : "Connect"}
          </Text>
        </View>
      </Pressable>

      <Modal visible={setupVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setSetupVisible(false)}>
        <View style={styles.modalRoot}>
          <View style={styles.modalHeader}>
            <Pressable onPress={() => setSetupVisible(false)} style={styles.headerButton}>
              <Ionicons name="close" size={24} color={Colors.text} />
            </Pressable>
            <View style={styles.modalHeaderCopy}>
              <Text style={styles.modalTitle}>Connect glasses</Text>
              <Text style={styles.modalSubtitle}>Choose the exact Bluetooth device Jarvis should use.</Text>
            </View>
            <View style={styles.headerButton} />
          </View>

          <ScrollView contentContainerStyle={styles.modalContent}>
            <SetupStep number="1" title="Allow Nearby Devices and microphone" complete={status?.eyevuePermissionGranted === true && microphoneReady}>
              <Text style={styles.stepDetail}>Android must allow Jarvis to scan for Bluetooth devices and keep its microphone service armed for a locked-screen EYE VUE wake.</Text>
              {status?.eyevuePermissionGranted !== true && (
                <ActionButton label="Allow Nearby Devices" busy={busy === "permission"} onPress={requestPermission} />
              )}
              {!microphoneReady && <ActionButton label="Allow microphone" busy={busy === "microphone"} onPress={requestMicrophone} />}
            </SetupStep>

            <SetupStep number="2" title="Discover and choose your glasses" complete={connected}>
              <Text style={styles.stepDetail}>Turn the glasses on and put them in pairing mode, then scan. Jarvis will not auto-select a device by its name.</Text>
              <ActionButton label={busy === "scan" ? "Scanning for 8 seconds…" : "Scan nearby devices"} busy={busy === "scan"} onPress={scan} disabled={status?.eyevuePermissionGranted !== true || !microphoneReady} />
              {devices.length > 0 && (
                <View style={styles.deviceList}>
                  {devices.map(device => (
                    <Pressable key={device.address} style={styles.deviceRow} onPress={() => connect(device)} disabled={busy !== null}>
                      <View style={styles.deviceIcon}>
                        <Ionicons name={device.advertisedAa12 ? "glasses-outline" : "bluetooth-outline"} size={18} color={device.advertisedAa12 ? Colors.primary : Colors.textSecondary} />
                      </View>
                      <View style={styles.copy}>
                        <Text style={styles.deviceName}>{device.name}</Text>
                        <Text style={styles.deviceMeta}>{device.bonded ? "Already paired" : "Available to pair"} · {device.address}</Text>
                      </View>
                      {busy === "connect" ? <ActivityIndicator size="small" color={Colors.primary} /> : <Text style={styles.pairText}>Pair</Text>}
                    </Pressable>
                  ))}
                </View>
              )}
              {devices.length === 0 && busy !== "scan" && <Text style={styles.emptyText}>No scan results yet.</Text>}
              {connected && <Text style={styles.successText}>Connected to {status?.eyevueDeviceName || "your selected glasses"}.</Text>}
            </SetupStep>

            <SetupStep number="3" title="Allow microphone and test wake" complete={wakeEvents > 0 && microphoneReady && recognizerReady && voiceReady}>
              <Text style={styles.stepDetail}>Jarvis listens to the glasses’ BLE control notifications. The EYE VUE firmware recognizes “Hey Star”; Android’s default-assistant setting does not replace this bridge.</Text>
              {connected && !voiceReady && <Text style={styles.stepDetail}>{eyeVueVoiceReadiness.detail}</Text>}
              {connected && <Text style={styles.successText}>{wakeEvents > 0 ? `Wake received ${wakeEvents} time${wakeEvents === 1 ? "" : "s"}.` : "Say “Hey Star” while this connection stays active."}</Text>}
            </SetupStep>

            <SetupStep number="4" title="Optional: choose Jarvis as Android assistant" complete={status?.assistantActive === true}>
              <Text style={styles.stepDetail}>This helps with Android’s normal assistant gesture, but it is not required for EYE VUE’s BLE wake event.</Text>
              {status?.assistantActive !== true && <ActionButton label="Open Android assistant settings" busy={busy === "assistant"} onPress={chooseAssistant} />}
            </SetupStep>

            <ActionButton label="Copy EYE VUE diagnostics" busy={busy === "diagnostics"} onPress={copyDiagnostics} />

            {error && (
              <View style={styles.errorCard}>
                <Ionicons name="alert-circle-outline" size={18} color={Colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

function SetupStep({ number, title, complete, children }: React.PropsWithChildren<{ number: string; title: string; complete: boolean }>) {
  return (
    <View style={styles.stepCard}>
      <View style={styles.stepHeader}>
        <View style={[styles.stepNumber, complete && styles.stepNumberComplete]}>
          {complete ? <Ionicons name="checkmark" size={14} color="#fff" /> : <Text style={styles.stepNumberText}>{number}</Text>}
        </View>
        <Text style={styles.stepTitle}>{title}</Text>
      </View>
      <View style={styles.stepBody}>{children}</View>
    </View>
  );
}

function ActionButton({ label, busy, onPress, disabled = false }: { label: string; busy: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={[styles.actionButton, (disabled || busy) && styles.actionButtonDisabled]} onPress={onPress} disabled={disabled || busy}>
      {busy && <ActivityIndicator size="small" color="#fff" />}
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  connectionRow: { minHeight: 76, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border, backgroundColor: Colors.surface, flexDirection: "row", alignItems: "center", gap: 12 },
  connectionRowReady: { backgroundColor: "rgba(34,197,94,0.04)" },
  connectionIcon: { width: 40, height: 40, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(124,58,237,0.12)" },
  connectionIconReady: { backgroundColor: "rgba(34,197,94,0.12)" },
  connectionTitle: { color: Colors.text, fontSize: 14, fontWeight: "700" },
  connectionDetail: { color: Colors.textSecondary, fontSize: 11, marginTop: 3, lineHeight: 15 },
  connectionButton: { minHeight: 36, paddingHorizontal: 14, borderRadius: 9, borderWidth: 1, borderColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  connectionButtonReady: { borderColor: Colors.success, backgroundColor: "rgba(34,197,94,0.12)" },
  connectionButtonText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },
  connectionButtonTextReady: { color: Colors.success },
  copy: { flex: 1, minWidth: 0 },
  modalRoot: { flex: 1, backgroundColor: Colors.background },
  modalHeader: { minHeight: 72, paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.border, flexDirection: "row", alignItems: "center" },
  modalHeaderCopy: { flex: 1, alignItems: "center" },
  modalTitle: { color: Colors.text, fontSize: 18, fontWeight: "800" },
  modalSubtitle: { color: Colors.textSecondary, fontSize: 11, marginTop: 3, textAlign: "center" },
  headerButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  modalContent: { padding: 16, gap: 12, paddingBottom: 36 },
  stepCard: { borderRadius: 14, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface, padding: 14 },
  stepHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepNumber: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: Colors.surfaceAlt },
  stepNumberComplete: { backgroundColor: Colors.success },
  stepNumberText: { color: Colors.text, fontSize: 12, fontWeight: "700" },
  stepTitle: { color: Colors.text, fontSize: 15, fontWeight: "700", flex: 1 },
  stepBody: { paddingTop: 10, paddingLeft: 36, gap: 10 },
  stepDetail: { color: Colors.textSecondary, fontSize: 12, lineHeight: 18 },
  actionButton: { minHeight: 42, borderRadius: 10, paddingHorizontal: 14, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  actionButtonDisabled: { opacity: 0.45 },
  actionButtonText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  deviceList: { borderWidth: 1, borderColor: Colors.border, borderRadius: 10, overflow: "hidden" },
  deviceRow: { minHeight: 62, paddingHorizontal: 10, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  deviceIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", backgroundColor: Colors.surfaceAlt },
  deviceName: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  deviceMeta: { color: Colors.textTertiary, fontSize: 10, marginTop: 3 },
  pairText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },
  emptyText: { color: Colors.textTertiary, fontSize: 11 },
  successText: { color: Colors.success, fontSize: 12, fontWeight: "600" },
  errorCard: { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.35)", backgroundColor: "rgba(239,68,68,0.08)", flexDirection: "row", alignItems: "flex-start", gap: 8 },
  errorText: { color: Colors.error, fontSize: 12, lineHeight: 17, flex: 1 },
});
