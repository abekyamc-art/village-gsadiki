import * as WebBrowser from 'expo-web-browser'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient, AsyncStorageAdapter } from '@blinkdotnew/sdk'

export const blink = createClient({
  projectId: process.env.EXPO_PUBLIC_BLINK_PROJECT_ID || 'village-voice-app-kn8pvg1l',
  publishableKey: process.env.EXPO_PUBLIC_BLINK_PUBLISHABLE_KEY || 'blnk_pk_kM4hCtPj3JYpHjDeGyaGS-diMpsd6IR_',
  authRequired: false,
  auth: { mode: 'headless', webBrowser: WebBrowser },
  storage: new AsyncStorageAdapter(AsyncStorage),
})
