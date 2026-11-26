import {
  MOBILE_BRIDGE_VERSION,
  buildBridgeInjectionScript,
  parseAppPath,
  type NativeShellHandshake,
} from "@omnyo/mobile-bridge";
import Constants from "expo-constants";
import { nativeApplicationVersion, nativeBuildVersion } from "expo-application";
import CookieManager from "@react-native-cookies/cookies";
import {
  Redirect,
  useFocusEffect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { AppState, BackHandler, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebViewKeyboardFrame } from "./WebViewKeyboardFrame";
import { WebView, type WebViewProps } from "react-native-webview";
import { revealApp, useProfiles } from "@/app-shell";
import { describeError } from "@/lib/describe-error";
import { nativeSessionCache } from "@/lib/native";
import {
  buildShellUrl,
  clearWebsiteData,
  decideShellNavigation,
  resolveShellLoadPath,
  resolveShellOpen,
  resolveShellScreenState,
  revealsShellFailure,
  SHELL_ORIGIN_WHITELIST,
  shellPathFromUrl,
  shouldReloadForSession,
  subscribeToShellCommands,
  type ShellLoadPhase,
  type ShellPath,
} from "@/lib/shell";
import type { ShellScreenState } from "@/lib/shell/shell-state";
import {
  connectEnrollHref,
  firstParam,
  settingsSectionHref,
} from "@/screens/shell/hrefs";
import { useTheme } from "@/theme";
import { Button, EmptyStatePanel, Spinner, Text, toast } from "@/ui";
import { Linking } from "react-native";
import { useShellBridge } from "./useShellBridge";

const APP_VERSION =
  nativeApplicationVersion ?? String(Constants.expoConfig?.version ?? "0.0.0");

const ANDROID_VERSION_CODE = Number(nativeBuildVersion);

const IDLE_SESSION = { status: "idle" } as const;

export function ProfileWebViewScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const params = useLocalSearchParams<{
    profileId?: string;
    path?: string;
  }>();

  const {
    status,
    profiles,
    activeProfile,
    connection,
    setActiveProfile,
    renewSession,
    reportShellAuthFailure,
  } = useProfiles();

  const requestedProfileId = firstParam(params.profileId);
  const requestedPath = firstParam(params.path);

  const profile = activeProfile;

  const unavailable = connection?.client === null ? connection.session : null;
  const session = connection?.client ? connection.session : IDLE_SESSION;
  const webViewRef = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const pageNavigates = useRef(false);
  const [load, setLoad] = useState<ShellLoadPhase>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  const [openPath, setOpenPath] = useState<ShellPath | null>(null);

  const [visited, setVisited] = useState<ShellPath | null>(null);

  const loadScope =
    profile === null ? null : `${profile.id}#${profile.serverUrl}`;

  useEffect(() => {
    setLoad({ kind: "loading" });
  }, [loadScope]);

  useEffect(() => {
    canGoBack.current = false;
    pageNavigates.current = false;
  }, [loadScope, reloadKey]);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;

      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          if (!canGoBack.current || webViewRef.current === null) return false;
          webViewRef.current.goBack();

          return true;
        },
      );

      return () => subscription.remove();
    }, []),
  );

  const sourceUrl = useMemo(() => {
    if (profile === null) return null;

    const path = resolveShellLoadPath({
      scope: loadScope,
      openPath,
      visitedPath: visited,
    });

    return buildShellUrl(profile.serverUrl, path);
  }, [loadScope, openPath, profile, visited]);

  const rememberPath = useCallback(
    (path: string) => {
      if (loadScope === null) return;
      setVisited((previous) =>
        previous !== null &&
        previous.scope === loadScope &&
        previous.path === path
          ? previous
          : { scope: loadScope, path },
      );
    },
    [loadScope],
  );

  const openServers = useCallback(() => {
    router.push(settingsSectionHref("device"));
  }, [router]);

  const bridge = useShellBridge(webViewRef, {
    onReady: (path) => {
      setLoad({ kind: "ready" });
      setOpenPath((previous) =>
        previous?.scope === loadScope ? null : previous,
      );
      revealApp();
      rememberPath(path);
    },
    onPath: rememberPath,
    onCapabilities: (capabilities) => {
      pageNavigates.current = capabilities.includes("navigate");
    },
    onOpenNative: (screen) => {
      if (screen === "device-settings") openServers();
    },
  });

  const openRequest = useEffectEvent(
    (profileId: string | undefined, path: string | undefined) => {
      const target = profiles.find(
        (candidate) => candidate.id === (profileId ?? activeProfile?.id),
      );

      if (target === undefined) return;
      const switchingProfile = target.id !== activeProfile?.id;

      if (switchingProfile) void setActiveProfile(target.id);

      if (path === undefined || path.length === 0) return;
      const appPath = parseAppPath(path);

      if (appPath === null) return;

      const action = resolveShellOpen({
        switchingProfile,
        load,
        pageNavigates: pageNavigates.current && webViewRef.current !== null,
      });

      if (action === "navigate") {
        bridge.send({ type: "navigate", path: appPath });
        rememberPath(appPath);

        return;
      }

      setOpenPath({ scope: `${target.id}#${target.serverUrl}`, path: appPath });

      if (switchingProfile) return;
      setLoad({ kind: "loading" });
      setReloadKey((value) => value + 1);
    },
  );

  useEffect(() => {
    if (status !== "ready") return;

    if (requestedProfileId === undefined && requestedPath === undefined) return;
    router.setParams({ profileId: undefined, path: undefined });
    openRequest(requestedProfileId, requestedPath);
  }, [requestedPath, requestedProfileId, router, status]);

  const connectProfileId = profile?.mode === "connect" ? profile.id : null;
  useEffect(
    () =>
      subscribeToShellCommands((command) => {
        setLoad({ kind: "loading" });

        if (command.kind !== "clear-website-data") {
          setReloadKey((value) => value + 1);

          return;
        }

        webViewRef.current?.clearCache(true);
        void clearWebsiteData(connectProfileId, {
          clearCookies: (useWebKit) => CookieManager.clearAll(useWebKit),
          clearSessionCache: (profileId) => nativeSessionCache.clear(profileId),
          renewSession,
        })
          .then(
            () => toast.success("Cleared"),
            (error: unknown) => {
              toast.error("Could not clear website data", {
                description: describeError(error),
              });
            },
          )
          .finally(() => setReloadKey((value) => value + 1));
      }),
    [connectProfileId, renewSession],
  );

  const safeArea = useMemo(
    () => ({
      top: insets.top,
      right: insets.right,
      bottom: insets.bottom,
      left: insets.left,
    }),
    [insets.bottom, insets.left, insets.right, insets.top],
  );

  const hasSentHandshake = useRef(false);
  useEffect(() => {
    if (!hasSentHandshake.current) {
      hasSentHandshake.current = true;

      return;
    }

    bridge.send({ type: "safe-area", safeArea });
  }, [bridge, safeArea]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") bridge.send({ type: "resume" });
    });

    return () => subscription.remove();
  }, [bridge]);

  const previousSession = useRef(session);
  useEffect(() => {
    if (
      shouldReloadForSession(previousSession.current, session, Date.now(), load)
    ) {
      setReloadKey((value) => value + 1);
      setLoad({ kind: "loading" });
    }

    previousSession.current = session;
  }, [load, session]);

  const handshake = useMemo<NativeShellHandshake | null>(() => {
    if (profile === null || sourceUrl === null) return null;

    return {
      bridgeVersion: MOBILE_BRIDGE_VERSION,
      appVersion: APP_VERSION,
      ...(Platform.OS === "android" &&
      Number.isSafeInteger(ANDROID_VERSION_CODE) &&
      ANDROID_VERSION_CODE > 0
        ? { androidVersionCode: ANDROID_VERSION_CODE }
        : {}),
      platform: Platform.OS === "android" ? "android" : "ios",
      profileMode: profile.mode,
      secureContext: sourceUrl.startsWith("https://"),
      safeArea,
      capabilities: [
        "haptic",
        "badge",
        "share",
        "open-external",
        "safe-area",
        "open-native",
      ],
    };
  }, [profile, safeArea, sourceUrl]);

  const injectionScript = useMemo(
    () =>
      handshake === null ? undefined : buildBridgeInjectionScript(handshake),
    [handshake],
  );

  const retry = useCallback(() => {
    setLoad({ kind: "loading" });
    setReloadKey((value) => value + 1);
  }, []);

  const screen: ShellScreenState =
    unavailable !== null
      ? {
          kind: "error",
          title: "Pair this server again",
          detail: unavailable.detail,
          action: "re-pair",
        }
      : resolveShellScreenState({
          storeReady: status === "ready",
          hasAnyProfile: profiles.length > 0,
          hasProfile: profile !== null && sourceUrl !== null,
          requiresSession: profile?.mode === "connect",
          session,
          load,
        });

  useEffect(() => {
    if (screen.kind !== "reconnecting" || loadScope === null) return;

    const timer = setTimeout(retry, 2_000);

    return () => clearTimeout(timer);
  }, [loadScope, retry, screen.kind]);

  const showsFailure = revealsShellFailure(screen, profile?.mode === "connect");
  useEffect(() => {
    if (showsFailure) revealApp();
  }, [showsFailure]);

  if (screen.kind === "no-profile") {
    return <Redirect href="/settings/servers/add" />;
  }

  if (screen.kind === "loading" || screen.kind === "reconnecting") {
    return (
      <View
        className="flex-1 items-center justify-center gap-3"
        testID={
          screen.kind === "reconnecting"
            ? "shell-reconnecting"
            : "shell-loading"
        }
      >
        <Spinner />
        <Text className="text-sm text-muted-foreground">{screen.message}</Text>
        {screen.kind === "reconnecting" ? (
          <Button
            variant="ghost"
            testID="shell-device-settings"
            onPress={openServers}
          >
            Servers
          </Button>
        ) : null}
      </View>
    );
  }

  if (screen.kind === "error") {
    return (
      <View
        className="flex-1 justify-center p-6"
        style={{
          paddingLeft: 24 + insets.left,
          paddingRight: 24 + insets.right,
        }}
        testID="shell-error"
      >
        <EmptyStatePanel>
          <View className="items-center gap-3">
            <Text className="text-center text-base font-semibold">
              {screen.title}
            </Text>
            <Text className="text-center text-sm text-muted-foreground">
              {screen.detail}
            </Text>
            {screen.action === "retry" ? (
              <Button testID="shell-retry" onPress={retry}>
                Try again
              </Button>
            ) : null}
            {screen.action === "re-pair" ? (
              <Button
                testID="shell-repair"
                onPress={() =>
                  router.push(
                    profile === null
                      ? settingsSectionHref("device")
                      : connectEnrollHref({ profileId: profile.id }),
                  )
                }
              >
                Pair again
              </Button>
            ) : null}
            <Button
              variant="ghost"
              testID="shell-device-settings"
              onPress={openServers}
            >
              Servers
            </Button>
          </View>
        </EmptyStatePanel>
      </View>
    );
  }

  if (
    profile === null ||
    loadScope === null ||
    sourceUrl === null ||
    handshake === null
  ) {
    return null;
  }

  return (
    <WebViewKeyboardFrame
      style={{ flex: 1, backgroundColor: tokens.background }}
      testID="shell-webview"
    >
      <ShellWebView
        key={`${loadScope}#${reloadKey}`}
        ref={webViewRef}
        initialUrl={sourceUrl}
        style={{ backgroundColor: tokens.background }}
        originWhitelist={SHELL_ORIGIN_WHITELIST}
        sharedCookiesEnabled
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grant"
        hideKeyboardAccessoryView
        allowsBackForwardNavigationGestures={false}
        bounces={false}
        pullToRefreshEnabled={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        webviewDebuggingEnabled={__DEV__}
        injectedJavaScriptBeforeContentLoaded={injectionScript}
        onMessage={(event) => {
          canGoBack.current = event.nativeEvent.canGoBack;
          bridge.onMessage(event);
        }}
        onShouldStartLoadWithRequest={(request) => {
          const decision = decideShellNavigation(request, profile);

          if (decision === "relay-sign-in") {
            setLoad({ kind: "http-error", status: 401 });
            reportShellAuthFailure(profile.id);
          }

          if (decision === "open-external") {
            void Linking.openURL(request.url).catch(() => undefined);
          }

          return decision === "load";
        }}
        onNavigationStateChange={(state) => {
          canGoBack.current = state.canGoBack;
          const path = shellPathFromUrl(state.url, profile.serverUrl);

          if (path !== null) rememberPath(path);
        }}
        onLoadStart={() => {
          pageNavigates.current = false;
        }}
        onLoadEnd={() =>
          setLoad((previous) =>
            previous.kind === "loading" ? { kind: "ready" } : previous,
          )
        }
        onError={(event) =>
          setLoad({
            kind: "failed",
            detail: event.nativeEvent.description || "Unknown error",
            code: event.nativeEvent.code,
          })
        }
        onHttpError={(event) => {
          const { statusCode } = event.nativeEvent;

          if (statusCode >= 400)
            setLoad({ kind: "http-error", status: statusCode });
        }}
        onContentProcessDidTerminate={retry}
        onRenderProcessGone={retry}
      />
      {screen.serverErrorStatus !== null ? (
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 bottom-0 items-center"
          style={{ paddingBottom: insets.bottom + 16 }}
          testID="shell-server-error"
        >
          <Button
            variant="outline"
            icon="Settings"
            testID="shell-server-error-device-settings"
            onPress={openServers}
          >
            Servers
          </Button>
        </View>
      ) : null}
    </WebViewKeyboardFrame>
  );
}

type ShellWebViewProps = Omit<WebViewProps, "source"> & {
  initialUrl: string;
  ref: Ref<WebView>;
};

function ShellWebView({ initialUrl, ref, ...props }: ShellWebViewProps) {
  const [source] = useState(() => ({ uri: initialUrl }));

  return <WebView {...props} ref={ref} source={source} />;
}
