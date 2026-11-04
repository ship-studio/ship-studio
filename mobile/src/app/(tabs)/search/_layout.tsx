import { Stack } from 'expo-router';
import { stackOptions } from '../../../lib/navigation';

export default function TabStack() {
  return <Stack screenOptions={stackOptions} />;
}
