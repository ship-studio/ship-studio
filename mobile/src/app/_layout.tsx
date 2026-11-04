import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold } from '@expo-google-fonts/geist';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { DarkTheme, Stack, ThemeProvider, usePathname, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { MenuHost } from '../components/menu';
import { targetOf } from '../lib/notify';
import {
  initialQuickAction,
  onQuickAction,
  quickTarget,
  syncQuickActions,
  type QuickTarget,
} from '../lib/quickActions';
import { boot, watchLifecycle } from '../lib/session';
import { useApp } from '../lib/store';
import { sheet, stackOptions } from '../lib/navigation';
import { colors } from '../lib/theme';

void SplashScreen.preventAutoHideAsync();

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.surfaceApp,
    card: colors.surfaceApp,
    border: colors.borderDefault,
    text: colors.textPrimary,
    primary: colors.accentActive,
  },
};

export default function RootLayout() {
  const router = useRouter();
  const [fontsLoaded] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    GeistMono_400Regular,
  });
  const credentialsRead = useApp((s) => s.credentials !== undefined);
  const paired = useApp((s) => !!s.credentials);
  const pathname = usePathname();
  // A tapped alert or quick action waits here until there is a navigator to open it in.
  const [tapped, setTapped] = useState<QuickTarget | null>(null);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    void boot();
    return watchLifecycle();
  }, []);

  useEffect(() => {
    if (fontsLoaded && credentialsRead) void SplashScreen.hideAsync();
  }, [fontsLoaded, credentialsRead]);

  // Tapping an alert (local or pushed) opens that agent's chat at the
  // message it was about. Each response is handled once: a cold start hands
  // the same one to both the last-response read and the listener.
  useEffect(() => {
    const take = (response: Notifications.NotificationResponse | null) => {
      const target = targetOf(response?.notification.request);
      const key =
        response && `${response.notification.request.identifier}@${response.notification.date}`;
      if (!target || !key || seen.current.has(key)) return;
      seen.current.add(key);
      setTapped(target);
    };
    take(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(take);
    return () => sub.remove();
  }, []);

  // Home Screen quick actions: the same path, resolved once the agents are known.
  useEffect(() => {
    const stop = syncQuickActions();
    const first = initialQuickAction();
    const choose = (a: Parameters<typeof quickTarget>[0]) => {
      const t = quickTarget(a);
      if (t) setTapped(t);
    };
    if (first) choose(first);
    const sub = onQuickAction(choose);
    return () => {
      stop();
      sub.remove();
    };
  }, []);

  const ready = fontsLoaded && credentialsRead;
  useEffect(() => {
    if (!ready || !tapped) return;
    // After the launch redirect has placed Home underneath. One chat on top,
    // never a stack of them: a chat already showing is replaced.
    const frame = requestAnimationFrame(() => {
      setTapped(null);
      // Unpaired by now (or never): the pair screen is where it belongs.
      if (!paired) return;
      if (tapped === 'home') return router.navigate('/agents');
      const href = {
        pathname: '/chat/[id]' as const,
        params: {
          id: tapped.agentId,
          ...(tapped.messageId ? { at: tapped.messageId } : {}),
          ...(tapped.compose ? { compose: '1' } : {}),
        },
      };
      if (pathname.startsWith('/chat/')) router.replace(href);
      else router.navigate(href);
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, tapped, paired, router, pathname]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.surfaceApp }}>
      <KeyboardProvider>
        <ThemeProvider value={theme}>
          <StatusBar style="light" />
          <Stack screenOptions={stackOptions}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="pair" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen
              name="scan"
              options={{ presentation: 'fullScreenModal', headerShown: false }}
            />
            <Stack.Screen name="(tabs)" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="chat/[id]" options={{ title: '' }} />
            <Stack.Screen name="agent/[id]" options={sheet([0.62, 1])} />
            <Stack.Screen name="schedule" options={sheet([0.5, 0.9])} />
            <Stack.Screen name="files/[id]" options={{ title: 'Files' }} />
            <Stack.Screen name="diff" options={sheet([0.75, 1])} />
            <Stack.Screen name="start" options={sheet([0.6, 0.9])} />
            <Stack.Screen name="instructions" options={sheet([0.9])} />
            <Stack.Screen name="session/[id]" options={{ title: '' }} />
            <Stack.Screen
              name="viewer"
              options={{
                presentation: 'fullScreenModal',
                headerShown: false,
                animation: 'fade',
                contentStyle: { backgroundColor: colors.black },
              }}
            />
            <Stack.Screen
              name="connection"
              options={{ ...sheet([0.75, 1]), contentStyle: undefined }}
            />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          </Stack>
          <MenuHost />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
