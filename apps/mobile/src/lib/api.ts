import Constants from 'expo-constants';
import { Platform } from 'react-native';

let accessToken: string | null = null;

export function setMobileAccessToken(token: string | null) {
  accessToken = token;
}

export function apiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(':')[0];
  return host ? `http://${host}:3000` : 'http://10.0.2.2:3000';
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${apiUrl()}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status}). Is the web API running at ${apiUrl()}?`);
  return payload as T;
}
