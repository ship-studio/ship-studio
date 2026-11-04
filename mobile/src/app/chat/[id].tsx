/** One conversation, full screen (see components/ChatView.tsx). */

import { useLocalSearchParams } from 'expo-router';
import { ChatView } from '../../components/ChatView';

export default function Chat() {
  const { id, at } = useLocalSearchParams<{ id: string; at?: string }>();
  return <ChatView id={id} at={at} />;
}
