import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Purchases, { type PurchasesPackage } from 'react-native-purchases';

const COIN_OFFERING_ID = 'coin_market';
let configured = false;
let configurationPromise: Promise<boolean> | null = null;

function apiKey() {
  if (Platform.OS === 'ios') return process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
  if (Platform.OS === 'android') return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  return undefined;
}

export async function initializeRevenueCat(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (configured) return true;
  if (configurationPromise) return configurationPromise;

  const key = apiKey();
  if (!key) return false;

  configurationPromise = (async () => {
    try {
      Purchases.configure({ apiKey: key });
      configured = true;
      return true;
    } catch {
      return false;
    }
  })();

  return configurationPromise;
}

export async function identifyRevenueCatUser(userId: string | null) {
  const ready = await initializeRevenueCat();
  if (Platform.OS === 'web' || !ready) return;
  if (userId) {
    await Purchases.logIn(userId);
  } else {
    await Purchases.logOut().catch(() => undefined);
  }
}

export async function purchaseCoinPackage(packageToPurchase: PurchasesPackage) {
  if (!(await initializeRevenueCat())) {
    throw new Error('Coin purchases are available in the iOS and Android apps.');
  }
  return Purchases.purchasePackage(packageToPurchase);
}

export async function restoreCoinPurchases() {
  if (!(await initializeRevenueCat())) {
    throw new Error('Purchase restoration is available in the iOS and Android apps.');
  }
  return Purchases.restorePurchases();
}

export function useCoinMarket(enabled: boolean) {
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setIsLoading(true);
    setError(null);
    try {
      if (!(await initializeRevenueCat())) {
        if (Platform.OS === 'web') {
          setError('Coin purchases are available in the iOS and Android apps.');
        }
        setPackages([]);
        return;
      }
      const offerings = await Purchases.getOfferings();
      const offering = offerings.all[COIN_OFFERING_ID] ?? offerings.current;
      setPackages(offering?.availablePackages ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Coin packs could not be loaded.');
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { packages, isLoading, error, refresh };
}
