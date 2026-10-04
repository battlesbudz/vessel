import { DeviceEventEmitter, NativeModules, Platform } from "react-native";

export type AndroidDaemonStatus = {
  available: boolean;
  connected: boolean;
  status: string;
  accessibilityEnabled: boolean;
  notificationListenerActive: boolean;
  notificationPermissionGranted?: boolean;
  notificationServiceConnected?: boolean;
  notificationComponentDeclared?: boolean;
  notificationComponentEnabled?: boolean;
  notificationRebindRequested?: boolean;
  notificationLastConnectedAt?: number;
  notificationLastDisconnectedAt?: number;
  notificationLastError?: string | null;
  notificationCacheCount?: number;
  assistantActive?: boolean;
  assistantStatus?: string;
  hotwordPhrase?: string;
  hotwordAvailability?: string;
  hotwordDetail?: string;
  hotwordRecognitionActive?: boolean;
  hotwordLastError?: string | null;
  voiceSessionActive?: boolean;
  voiceSessionState?: "idle" | "listening" | "speaking" | "working" | "approval" | "paused";
  voiceOverlayPermission?: boolean;
  serverUrl?: string;
  eyevueEnabled?: boolean;
  eyevueConnected?: boolean;
  eyevueDeviceName?: string | null;
  eyevueLastError?: string | null;
  eyevuePermissionGranted?: boolean;
  eyevueWakeEvents?: number;
  eyevueWakePacketsReceived?: number;
  eyevueLastWakePacketAt?: number | null;
  eyevueLastWakeAt?: number | null;
  eyevueWakeBridge?: string | null;
};

export type AndroidEyevueStatus = {
  available: boolean;
  enabled: boolean;
  connected: boolean;
  address?: string | null;
  deviceName?: string | null;
  batteryPercent?: number | null;
  capacityRaw?: string | null;
  lastPhotoPath?: string | null;
  lastError?: string | null;
  wakePhrase?: "Hey, Star";
  wakeBridge?: "ble_command_notify";
  wakeEvents?: number;
  lastWakeAt?: number | null;
  nativeStoragePreserved?: boolean;
};

export type AndroidEyevueDevice = {
  address: string;
  name: string;
  bonded: boolean;
  pairing: boolean;
  rssi?: number | null;
  advertisedAa12: boolean;
  deviceType: "classic" | "ble" | "dual" | "unknown";
};

export type AndroidLocalGemmaValidationOptions = {
  backend?: "auto" | "gpu" | "cpu" | "npu";
  contextTokens?: number;
  keepEngineWarm?: boolean;
  allowCpuFallback?: boolean;
  speculativeDecoding?: boolean;
  cachePolicy?: "default" | "fresh" | "none";
  profileId?: string;
  profileLabel?: string;
};

export type AndroidOutsideAppVoiceControlEvent = {
  action?: string;
  state?: string;
  outsideApp?: boolean;
  confirmationToken?: string;
  reactActive?: boolean;
};

export type AndroidNativeSpeechStatus = {
  available: boolean;
  speechRecognitionAvailable?: boolean;
  onDeviceRecognitionAvailable?: boolean;
  microphonePermissionGranted?: boolean;
  ttsAvailable?: boolean;
  ttsProvider?: string;
  locale?: string;
  status?: string;
  message?: string;
  listening?: boolean;
  modelDownloadComplete?: boolean;
  modelDownloadScheduled?: boolean;
  wearableAudioSupported?: boolean;
  wearableAudioAvailable?: boolean;
  wearableAudioActive?: boolean;
  wearableAudioStatus?: "idle" | "not_connected" | "available" | "requesting" | "active" | "failed" | "unsupported";
  wearableAudioDeviceName?: string | null;
  wearableAudioDeviceType?: string | null;
  wearableAudioMessage?: string;
  wearableAudioLastError?: string | null;
  talkModeSessionId?: number;
  talkModeAudioState?: AndroidTalkModeAudioState;
  talkModeAudioMode?: AndroidTalkModeAudioMode;
  talkModeCaptureOwner?: string | null;
  talkModePlaybackOwner?: string | null;
  talkModePartialTranscript?: string;
  talkModeSpeechSuppressed?: boolean;
  acousticEchoCancellationAvailable?: boolean;
  noiseSuppressionAvailable?: boolean;
  automaticGainControlAvailable?: boolean;
  echoControlsPlatformManaged?: boolean;
};

export type AndroidTalkModeAudioState =
  | "idle"
  | "listening"
  | "user-speaking"
  | "responding"
  | "speaking"
  | "interrupted"
  | "paused"
  | "recovering"
  | "ended";

export type AndroidTalkModeAudioMode = "continuous" | "turn-based";

export type AndroidTalkModeAudioSessionStatus = {
  sessionId: number;
  state: AndroidTalkModeAudioState;
  mode: AndroidTalkModeAudioMode;
  captureOwner?: string | null;
  playbackOwner?: string | null;
  partialTranscript?: string;
  committedTranscript?: string;
  speechSuppressed?: boolean;
  routeState?: string;
  lastError?: string | null;
  acousticEchoCancellationAvailable?: boolean;
  noiseSuppressionAvailable?: boolean;
  automaticGainControlAvailable?: boolean;
  echoControlsPlatformManaged?: boolean;
};

export type AndroidNativeSpeechRecognitionEvent = {
  type?: "ready" | "speech_start" | "speech_end" | "rms" | "partial" | "final" | "error" | "cancelled" | "model_download_requested" | "interruption_candidate" | "echo_rejected";
  text?: string;
  alternatives?: string[];
  confidenceScores?: number[];
  committed?: boolean;
  sessionState?: AndroidTalkModeAudioState;
  error?: string;
  errorCode?: number;
  message?: string;
  recoverable?: boolean;
  onDevice?: boolean;
  locale?: string;
  rmsDb?: number;
  completedPercent?: number;
  wearableAudioActive?: boolean;
  wearableAudioDeviceName?: string | null;
};

export type AndroidNativeSpeechRecognitionOptions = {
  locale?: string;
  interimResults?: boolean;
  timeoutMs?: number;
  takeInAppCapture?: boolean;
  onEvent?: (event: AndroidNativeSpeechRecognitionEvent) => void;
};

export type AndroidNativeSpeechRecognitionResult = {
  text: string;
  alternatives: string[];
};

const unavailableStatus: AndroidDaemonStatus = {
  available: false,
  connected: false,
  status: "Unavailable",
  accessibilityEnabled: false,
  notificationListenerActive: false,
};

const NativeJarvisDaemon = NativeModules.JarvisDaemonModule as
  | {
      getStatus(): Promise<AndroidDaemonStatus>;
      enable(serverUrl: string, bootstrapToken: string): Promise<AndroidDaemonStatus>;
      disconnect(): Promise<AndroidDaemonStatus>;
      openAccessibilitySettings(): Promise<void>;
      openNotificationListenerSettings(): Promise<void>;
      openAssistantSettings(): Promise<void>;
      refreshAssistantStatus(): Promise<AndroidDaemonStatus>;
      startOutsideAppVoiceSession?(): Promise<AndroidDaemonStatus>;
      handoffOutsideAppVoiceCapture?(): Promise<AndroidDaemonStatus>;
      pauseOutsideAppVoiceSession?(): Promise<AndroidDaemonStatus>;
      resumeOutsideAppVoiceSession?(): Promise<AndroidDaemonStatus>;
      endOutsideAppVoiceSession?(): Promise<AndroidDaemonStatus>;
      setOutsideAppVoiceSessionState?(state: string): Promise<AndroidDaemonStatus>;
      setOutsideAppVoiceApproval?(prompt: string, confirmationToken: string): Promise<AndroidDaemonStatus>;
      openOverlayPermissionSettings?(): Promise<void>;
      openAllFilesAccessSettings(): Promise<void>;
      requestCameraPermission(): Promise<void>;
      requestMicrophonePermission(): Promise<void>;
      requestEyevuePermissions?(): Promise<void>;
      armEyevueWake?(): Promise<void>;
      getEyevueDiagnostics?(): Promise<string>;
      requestScreenRecordPermission(): Promise<void>;
      getLocalGemmaStatus?(model: string): Promise<string | Record<string, unknown>>;
      validateLocalGemmaModel?(model: string): Promise<string | Record<string, unknown>>;
      validateLocalGemmaModelWithOptions?(model: string, optionsJson: string): Promise<string | Record<string, unknown>>;
      smokeTestLocalGemmaModel?(model: string, optionsJson: string): Promise<string | Record<string, unknown>>;
      getEyevueStatus?(): Promise<string | Record<string, unknown>>;
      scanEyevueDevices?(): Promise<string | Record<string, unknown>>;
      enableEyevue?(address: string): Promise<string | Record<string, unknown>>;
      disconnectEyevue?(): Promise<string | Record<string, unknown>>;
      sendEyevueCommand?(command: string, waitForPhoto: boolean): Promise<string | Record<string, unknown>>;
      getNativeSpeechStatus?(locale: string): Promise<AndroidNativeSpeechStatus>;
      startNativeSpeechRecognition?(optionsJson: string): Promise<AndroidNativeSpeechStatus>;
      stopNativeSpeechRecognition?(): Promise<AndroidNativeSpeechStatus>;
      cancelNativeSpeechRecognition?(): Promise<AndroidNativeSpeechStatus>;
      getNativeTalkModeAudioSessionStatus?(): Promise<AndroidTalkModeAudioSessionStatus>;
      beginNativeTalkModeResponse?(): Promise<AndroidTalkModeAudioSessionStatus>;
      beginNativeTalkModePlayback?(ownerId: string, spokenText: string): Promise<AndroidTalkModeAudioSessionStatus>;
      speakNativeTalkModeText?(ownerId: string, spokenText: string): Promise<{ status: "done" | "interrupted" | "stopped" | "replaced" | "ended" | "error"; error?: string | null; acknowledgedOffset?: number }>;
      finishNativeTalkModePlayback?(ownerId: string): Promise<AndroidTalkModeAudioSessionStatus>;
      stopNativeTalkModeSpeech?(): Promise<AndroidTalkModeAudioSessionStatus>;
      pauseNativeTalkModeListening?(): Promise<AndroidTalkModeAudioSessionStatus>;
      endNativeTalkModeAudioSession?(): Promise<AndroidTalkModeAudioSessionStatus>;
      acquireNativeVoicePlaybackRoute?(ownerId: string): Promise<void>;
      releaseNativeVoicePlaybackRoute?(ownerId: string): Promise<void>;
      triggerNativeSpeechModelDownload?(locale: string): Promise<AndroidNativeSpeechStatus>;
    }
  | undefined;

function parseNativeJsonResult(result: unknown): Record<string, unknown> | null {
  if (!result) return null;
  if (typeof result === "string") {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  }
  return typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
}

export async function getAndroidDaemonStatus(): Promise<AndroidDaemonStatus> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon) {
    return unavailableStatus;
  }
  return NativeJarvisDaemon.getStatus();
}

export async function getAndroidLocalGemmaStatus(model: string): Promise<Record<string, unknown> | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.getLocalGemmaStatus) {
    return null;
  }
  return parseNativeJsonResult(await NativeJarvisDaemon.getLocalGemmaStatus(model));
}

export async function validateAndroidLocalGemmaModel(model: string, options: AndroidLocalGemmaValidationOptions = {}): Promise<Record<string, unknown>> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.validateLocalGemmaModel) {
    throw new Error("Phone Gemma validation is only available in the Android app.");
  }
  const result = NativeJarvisDaemon.validateLocalGemmaModelWithOptions
    ? await NativeJarvisDaemon.validateLocalGemmaModelWithOptions(model, JSON.stringify(options))
    : await NativeJarvisDaemon.validateLocalGemmaModel(model);
  const parsed = parseNativeJsonResult(result);
  if (!parsed) throw new Error("Phone Gemma validation returned an empty status.");
  return parsed;
}

export async function smokeTestAndroidLocalGemmaModel(model: string, options: AndroidLocalGemmaValidationOptions = {}): Promise<Record<string, unknown>> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.smokeTestLocalGemmaModel) {
    throw new Error("Phone Gemma smoke test is only available in the Android app.");
  }
  const parsed = parseNativeJsonResult(await NativeJarvisDaemon.smokeTestLocalGemmaModel(model, JSON.stringify(options)));
  if (!parsed) throw new Error("Phone Gemma smoke test returned an empty result.");
  return parsed;
}

export async function getAndroidEyevueStatus(): Promise<AndroidEyevueStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.getEyevueStatus) return null;
  return parseNativeJsonResult(await NativeJarvisDaemon.getEyevueStatus()) as AndroidEyevueStatus | null;
}

export async function getAndroidEyevueDiagnostics(): Promise<string> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.getEyevueDiagnostics) {
    throw new Error("EYE VUE diagnostics are unavailable in this APK.");
  }
  return NativeJarvisDaemon.getEyevueDiagnostics();
}

export async function scanAndroidEyevueDevices(): Promise<AndroidEyevueDevice[]> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.scanEyevueDevices) {
    throw new Error("Glasses discovery is unavailable in this APK.");
  }
  const result = parseNativeJsonResult(await NativeJarvisDaemon.scanEyevueDevices());
  const devices = Array.isArray(result?.devices) ? result.devices : [];
  return devices.filter((device): device is AndroidEyevueDevice => (
    !!device && typeof device === "object" &&
    typeof (device as AndroidEyevueDevice).address === "string" &&
    typeof (device as AndroidEyevueDevice).name === "string"
  ));
}

export async function enableAndroidEyevue(address = ""): Promise<AndroidEyevueStatus> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.enableEyevue) throw new Error("eyeVue support is unavailable in this APK.");
  const result = parseNativeJsonResult(await NativeJarvisDaemon.enableEyevue(address));
  if (!result) throw new Error("eyeVue setup returned no status.");
  return result as AndroidEyevueStatus;
}

export async function disconnectAndroidEyevue(): Promise<AndroidEyevueStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.disconnectEyevue) return null;
  return parseNativeJsonResult(await NativeJarvisDaemon.disconnectEyevue()) as AndroidEyevueStatus | null;
}

export async function sendAndroidEyevueCommand(
  command: "battery" | "storage" | "photo" | "video_start" | "video_stop" | "audio_start" | "audio_stop",
  waitForPhoto = command === "photo",
): Promise<AndroidEyevueStatus> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.sendEyevueCommand) throw new Error("eyeVue support is unavailable in this APK.");
  const result = parseNativeJsonResult(await NativeJarvisDaemon.sendEyevueCommand(command, waitForPhoto));
  if (!result) throw new Error("eyeVue command returned no status.");
  return result as AndroidEyevueStatus;
}

export async function startAndroidOutsideAppVoiceSession(): Promise<AndroidDaemonStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.startOutsideAppVoiceSession) {
    return null;
  }
  return NativeJarvisDaemon.startOutsideAppVoiceSession();
}

export async function handoffAndroidOutsideAppVoiceCapture(): Promise<AndroidDaemonStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.handoffOutsideAppVoiceCapture) {
    return null;
  }
  return NativeJarvisDaemon.handoffOutsideAppVoiceCapture();
}

export async function endAndroidOutsideAppVoiceSession(): Promise<AndroidDaemonStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.endOutsideAppVoiceSession) {
    return null;
  }
  return NativeJarvisDaemon.endOutsideAppVoiceSession();
}

export async function setAndroidOutsideAppVoiceSessionState(
  state: string,
): Promise<AndroidDaemonStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.setOutsideAppVoiceSessionState) {
    return null;
  }
  return NativeJarvisDaemon.setOutsideAppVoiceSessionState(state);
}

export async function setAndroidOutsideAppVoiceApproval(
  prompt: string,
  confirmationToken = "",
): Promise<AndroidDaemonStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.setOutsideAppVoiceApproval) {
    return null;
  }
  return NativeJarvisDaemon.setOutsideAppVoiceApproval(prompt, confirmationToken);
}

export function addAndroidOutsideAppVoiceControlListener(
  listener: (event: AndroidOutsideAppVoiceControlEvent) => void,
): { remove: () => void } {
  if (Platform.OS !== "android" || !NativeJarvisDaemon) {
    return { remove: () => {} };
  }
  return DeviceEventEmitter.addListener("JarvisVoiceSessionControl", listener);
}

export async function getAndroidNativeSpeechStatus(locale = ""): Promise<AndroidNativeSpeechStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.getNativeSpeechStatus) {
    return null;
  }
  return NativeJarvisDaemon.getNativeSpeechStatus(locale);
}

export async function startAndroidNativeSpeechRecognition(
  options: AndroidNativeSpeechRecognitionOptions = {},
): Promise<AndroidNativeSpeechStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.startNativeSpeechRecognition) {
    return null;
  }
  return NativeJarvisDaemon.startNativeSpeechRecognition(JSON.stringify(options));
}

export async function stopAndroidNativeSpeechRecognition(): Promise<AndroidNativeSpeechStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.stopNativeSpeechRecognition) {
    return null;
  }
  return NativeJarvisDaemon.stopNativeSpeechRecognition();
}

export async function cancelAndroidNativeSpeechRecognition(): Promise<AndroidNativeSpeechStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.cancelNativeSpeechRecognition) {
    return null;
  }
  return NativeJarvisDaemon.cancelNativeSpeechRecognition();
}

export async function getAndroidTalkModeAudioSessionStatus(): Promise<AndroidTalkModeAudioSessionStatus | null> {
  return Platform.OS === "android" && NativeJarvisDaemon?.getNativeTalkModeAudioSessionStatus
    ? NativeJarvisDaemon.getNativeTalkModeAudioSessionStatus()
    : null;
}

export async function beginAndroidTalkModeResponse(): Promise<AndroidTalkModeAudioSessionStatus | null> {
  return Platform.OS === "android" && NativeJarvisDaemon?.beginNativeTalkModeResponse
    ? NativeJarvisDaemon.beginNativeTalkModeResponse()
    : null;
}

export async function beginAndroidTalkModePlayback(
  ownerId: string,
  spokenText: string,
): Promise<AndroidTalkModeAudioSessionStatus | null> {
  return Platform.OS === "android" && NativeJarvisDaemon?.beginNativeTalkModePlayback
    ? NativeJarvisDaemon.beginNativeTalkModePlayback(ownerId, spokenText)
    : null;
}

export async function speakAndroidTalkModeText(
  ownerId: string,
  spokenText: string,
  options: { onStart?: () => void } = {},
): Promise<{ status: "done" | "interrupted" | "stopped" | "replaced" | "ended" | "error"; error?: string | null; acknowledgedOffset?: number }> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.speakNativeTalkModeText) {
    throw new Error("Continuous Android Talk Mode playback is unavailable in this APK.");
  }
  const expectedOwner = `react_tts:${ownerId}`;
  const subscription = options.onStart
    ? DeviceEventEmitter.addListener("JarvisTalkModePlayback", (event) => {
        if (event?.type === "start" && event?.ownerId === expectedOwner) options.onStart?.();
      })
    : null;
  try {
    return await NativeJarvisDaemon.speakNativeTalkModeText(ownerId, spokenText);
  } finally {
    subscription?.remove();
  }
}

export async function finishAndroidTalkModePlayback(ownerId: string): Promise<AndroidTalkModeAudioSessionStatus | null> {
  return Platform.OS === "android" && NativeJarvisDaemon?.finishNativeTalkModePlayback
    ? NativeJarvisDaemon.finishNativeTalkModePlayback(ownerId)
    : null;
}

export async function stopAndroidTalkModeSpeech(): Promise<AndroidTalkModeAudioSessionStatus | null> {
  return Platform.OS === "android" && NativeJarvisDaemon?.stopNativeTalkModeSpeech
    ? NativeJarvisDaemon.stopNativeTalkModeSpeech()
    : null;
}

export async function pauseAndroidTalkModeListening(): Promise<AndroidTalkModeAudioSessionStatus | null> {
  return Platform.OS === "android" && NativeJarvisDaemon?.pauseNativeTalkModeListening
    ? NativeJarvisDaemon.pauseNativeTalkModeListening()
    : null;
}

export async function endAndroidTalkModeAudioSession(): Promise<AndroidTalkModeAudioSessionStatus | null> {
  return Platform.OS === "android" && NativeJarvisDaemon?.endNativeTalkModeAudioSession
    ? NativeJarvisDaemon.endNativeTalkModeAudioSession()
    : null;
}

export async function acquireAndroidNativeVoicePlaybackRoute(ownerId: string): Promise<void> {
  await NativeJarvisDaemon?.acquireNativeVoicePlaybackRoute?.(ownerId);
}

export async function releaseAndroidNativeVoicePlaybackRoute(ownerId: string): Promise<void> {
  await NativeJarvisDaemon?.releaseNativeVoicePlaybackRoute?.(ownerId);
}

export async function triggerAndroidNativeSpeechModelDownload(locale = ""): Promise<AndroidNativeSpeechStatus | null> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.triggerNativeSpeechModelDownload) {
    return null;
  }
  return NativeJarvisDaemon.triggerNativeSpeechModelDownload(locale);
}

export function addAndroidNativeSpeechRecognitionListener(
  listener: (event: AndroidNativeSpeechRecognitionEvent) => void,
): { remove: () => void } {
  if (Platform.OS !== "android" || !NativeJarvisDaemon) {
    return { remove: () => {} };
  }
  return DeviceEventEmitter.addListener("JarvisNativeSpeechRecognition", listener);
}

export async function recognizeAndroidSpeechOnce(
  options: AndroidNativeSpeechRecognitionOptions = {},
): Promise<AndroidNativeSpeechRecognitionResult> {
  if (Platform.OS !== "android" || !NativeJarvisDaemon?.startNativeSpeechRecognition) {
    throw new Error("Android on-device speech recognition is only available in the Android APK.");
  }

  const { onEvent, ...nativeOptions } = options;
  const status = await getAndroidNativeSpeechStatus(nativeOptions.locale ?? "");
  if (status && !status.available) {
    throw new Error(status.message || "Android on-device speech recognition is not available.");
  }

  return new Promise<AndroidNativeSpeechRecognitionResult>((resolve, reject) => {
    let settled = false;
    const timeoutMs = Math.max(options.timeoutMs ?? 60_000, 5_000);
    let subscription: { remove: () => void } = { remove: () => {} };
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      subscription.remove();
      callback();
    };

    subscription = addAndroidNativeSpeechRecognitionListener((event) => {
      try {
        onEvent?.(event);
      } catch (error) {
        console.warn("[android-native-speech] event observer failed:", error);
      }
      const eventType = String(event?.type ?? "");
      if (eventType === "final") {
        const text = String(event.text ?? "").trim();
        const alternatives = Array.isArray(event.alternatives)
          ? event.alternatives.map(value => String(value).trim()).filter(Boolean)
          : [];
        finish(() => resolve({ text, alternatives }));
      } else if (eventType === "error") {
        const message = event.message || event.error || "Android on-device speech recognition failed.";
        const recognitionError = Object.assign(new Error(message), {
          recoverable: event.recoverable === true,
          errorCode: event.errorCode,
          recognitionError: event.error,
        });
        finish(() => reject(recognitionError));
      } else if (eventType === "cancelled") {
        finish(() => reject(new Error("Android speech recognition was cancelled.")));
      }
    });

    timeout = setTimeout(() => {
      cancelAndroidNativeSpeechRecognition().catch(() => {});
      finish(() => reject(Object.assign(new Error("Android speech recognition timed out."), {
        recoverable: true,
      })));
    }, timeoutMs + 2_000);

    startAndroidNativeSpeechRecognition({
      interimResults: true,
      ...nativeOptions,
      timeoutMs,
    }).catch((error) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}

export const AndroidDaemonNative = NativeJarvisDaemon;
