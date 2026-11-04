import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold } from '@expo-google-fonts/geist';
import { GeistMono_400Regular } from '@expo-google-fonts/geist-mono';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { DarkTheme, Stack, ThemeProvider, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { MenuHost } from '../components/menu';
import { agentFromResponse } from '../lib/push';
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

  useEffect(() => {
    void boot();
    return watchLifecycle();
  }, []);

  useEffect(() => {
    if (fontsLoaded && credentialsRead) void SplashScreen.hideAsync();
  }, [fontsLoaded, credentialsRead]);

  // Tapping an alert (local or pushed) opens that agent's chat.
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const agentId = agentFromResponse(response);
      if (agentId) router.push({ pathname: '/chat/[id]', params: { id: agentId } });
    };
    open(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [router]);

  if (!fontsLoaded || !credentialsRead) return null;

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
