import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

WebBrowser.maybeCompleteAuthSession();
let client: SupabaseClient | null = null;

export function authConfigured() {
  return Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
}

export function getSupabase() {
  if (!client) {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('Supabase is not configured.');
    client = createClient(url, key, {
      auth: {
        storage: {
          getItem: SecureStore.getItemAsync,
          setItem: SecureStore.setItemAsync,
          removeItem: SecureStore.deleteItemAsync,
        },
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export async function googleSignIn() {
  const returnUrl = Linking.createURL('/');
  const { data, error } = await getSupabase().auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: returnUrl, skipBrowserRedirect: true },
  });
  if (error || !data.url) throw error ?? new Error('Google did not return a sign-in URL.');
  const result = await WebBrowser.openAuthSessionAsync(data.url, returnUrl);
  if (result.type !== 'success') return null;
  const url = new URL(result.url);
  const params = new URLSearchParams(url.hash.replace(/^#/, '') || url.search);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) throw new Error('The sign-in callback did not include a session.');
  return getSupabase().auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
}
