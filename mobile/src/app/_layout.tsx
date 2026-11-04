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
import { boot, watchLifecycle } from '../lib/session';
import { useApp } from '../lib/store';
import { colors, fonts } from '../lib/theme';

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

  // Tapping an alert opens that agent's chat.
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const agentId = response?.notification.request.content.data?.agentId;
      if (typeof agentId === 'string')
        router.push({ pathname: '/chat/[id]', params: { id: agentId } });
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
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.surfaceApp },
              headerTransparent: false,
              headerShadowVisible: false,
              headerTintColor: colors.textPrimary,
              headerTitleStyle: { fontFamily: fonts.semibold, color: colors.textWhite },
              headerBackButtonDisplayMode: 'minimal',
              contentStyle: { backgroundColor: colors.surfaceApp },
            }}
          >
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="pair" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen
              name="scan"
              options={{ presentation: 'fullScreenModal', headerShown: false }}
            />
            <Stack.Screen
              name="agents"
              options={{ title: 'Agents', headerBackVisible: false, gestureEnabled: false }}
            />
            <Stack.Screen name="chat/[id]" options={{ title: '' }} />
            <Stack.Screen
              name="connection"
              options={{
                title: 'Connection',
                presentation: 'formSheet',
                sheetAllowedDetents: [0.75, 1],
                sheetGrabberVisible: true,
                headerShown: false,
              }}
            />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          </Stack>
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
