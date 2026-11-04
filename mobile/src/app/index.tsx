import { Redirect } from 'expo-router';
import { useApp } from '../lib/store';

export default function Index() {
  const paired = useApp((s) => Boolean(s.credentials));
  return <Redirect href={paired ? '/agents' : '/pair'} />;
}
