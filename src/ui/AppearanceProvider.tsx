import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { AppearancePreferences } from '../domain/appearance';
import { appearanceRepository } from '../platform/appearance';
import { en } from '../i18n/en';
import { AppearanceContext } from './appearanceContext';
import { useTheme } from './theme';

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preferences] = useState(() => new AppearancePreferences(appearanceRepository));
  const [state, setState] = useState(preferences.snapshot());
  useEffect(() => {
    const unsubscribe = preferences.subscribe(setState);
    setState(preferences.snapshot());
    void preferences.load();
    return unsubscribe;
  }, [preferences]);
  // On a read failure the app still opens using System; Appearance offers a retry.
  return <AppearanceContext.Provider value={{ preferences, state }}>
    {!state.initialized ? <LoadingAppearance /> : children}
  </AppearanceContext.Provider>;
}
function LoadingAppearance() {
  const t = useTheme();
  return <View style={[styles.loading, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <ActivityIndicator accessibilityLabel={en.appearanceLoading} color={t.secondary} />
  </View>;
}
const styles = StyleSheet.create({ loading: { flex: 1, justifyContent: 'center', alignItems: 'center' } });
