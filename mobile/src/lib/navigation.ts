/** Header styling every stack shares: the root one and each tab's own. */

import type { Stack } from 'expo-router';
import type { ComponentProps } from 'react';
import { colors, fonts } from './theme';

type NativeStackNavigationOptions = Exclude<
  ComponentProps<typeof Stack.Screen>['options'],
  ((...args: never[]) => unknown) | undefined
>;

export const stackOptions: NativeStackNavigationOptions = {
  headerStyle: { backgroundColor: colors.surfaceApp },
  headerTransparent: false,
  headerShadowVisible: false,
  headerTintColor: colors.textPrimary,
  headerTitleStyle: { fontFamily: fonts.semibold, color: colors.textWhite },
  headerBackButtonDisplayMode: 'minimal',
  contentStyle: { backgroundColor: colors.surfaceApp },
};

/** A sheet that rises from the bottom: the agent sheet, a schedule, a session. */
export const sheet = (detents: number[] = [0.6, 1]): NativeStackNavigationOptions => ({
  presentation: 'formSheet',
  sheetAllowedDetents: detents,
  sheetGrabberVisible: true,
  sheetCornerRadius: 22,
  headerShown: false,
  contentStyle: { backgroundColor: colors.surfacePanel },
});
