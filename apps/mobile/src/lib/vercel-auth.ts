import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { api, setMobileAccessToken } from './api';

const SESSION_KEY = 'slop-vercel-session';
WebBrowser.maybeCompleteAuthSession();

export async function restoreVercelSession(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(SESSION_KEY);
  setMobileAccessToken(token);
  return token;
}

export async function signInWithVercel(): Promise<void> {
  const { authorizationUrl } = await api<{ authorizationUrl: string }>('/api/auth/vercel?platform=android');
  const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, 'slopbot://auth');
  if (result.type !== 'success') throw new Error('Vercel sign-in was cancelled.');
  const token = new URL(result.url).searchParams.get('token');
  if (!token) throw new Error('The Vercel callback did not include a session.');
  await SecureStore.setItemAsync(SESSION_KEY, token);
  setMobileAccessToken(token);
}

export async function clearVercelSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  setMobileAccessToken(null);
}
