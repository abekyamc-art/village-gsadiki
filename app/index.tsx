import { useEffect, useRef, useState } from 'react';
import type { VillageVoiceAdminMessagesRow, VillageVoiceCoinBalancesRow, VillageVoiceKnowledgeRow } from '@/lib/db-types';
import { Platform, AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { Audio as ExpoAudio } from 'expo-av';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Image as ExpoImage } from 'expo-image';
import { blink } from '@/lib/blink';
import { identifyRevenueCatUser, purchaseCoinPackage, restoreCoinPurchases, useCoinMarket } from '@/lib/payments';
import {
  ArrowRight,
  Check,
  Flame,
  Headphones,
  Leaf,
  LockKeyhole,
  MessageCircle,
  Mic,
  Play,
  Send,
  CircleStop,
  Volume2,
  Pencil,
  X,
  XStack,
  YStack,
  Card,
  Button,
  H1,
  H2,
  H3,
  Paragraph,
  SizableText,
  ScrollView,
  Progress,
  Input,
} from '@blinkdotnew/mobile-ui';

const AVATAR_URL = 'https://storage.googleapis.com/blink-core-storage/projects/village-voice-app-kn8pvg1l/ai-images/1789608641560-1bc4549f-0214-47cf-8f65-4427d70acc55.png';
const TAVI_FULL_NAME = 'GLOIRE SADIKI MBEMBE MBONDO MWANA WA BASHIMNYAKA NYUMBA YA MMENDO ELEPONGAA';
const ADMIN_USER_ID = 'Dc7JZfGsOOVdYYy5EQHZuVaPgv22';
const AVATAR_GREETING = `Mōra, Amara. I am ${TAVI_FULL_NAME}, your Village Voice guide. Ask me about a word, a greeting, or the story behind our language.`;
const FREE_AI_USES = 2;
const AI_COIN_COST = 1;
const FREE_AI_USES_KEY = 'village-voice-free-ai-uses';
const STUDIO_CLIP_COUNT = 4;
const STUDIO_PACK_INDEX = 1;
const COIN_PACKS = [
  { coins: 100, price: '$0.99' },
  { coins: 500, price: '$3.99' },
  { coins: 1200, price: '$7.99' },
];
const TRANSCRIPTION_ENDPOINT = 'https://kn8pvg1l.backend.blink.new/api/transcribe';

const knowledgeTable = blink.db.table<VillageVoiceKnowledgeRow>('village_voice_knowledge');
const adminMessagesTable = blink.db.table<VillageVoiceAdminMessagesRow>('village_voice_admin_messages');
const coinBalancesTable = blink.db.table<VillageVoiceCoinBalancesRow>('village_voice_coin_balances');

type ConversationLanguage = 'community' | 'swahili' | 'english';
type ConversationMode = 'chat' | 'joke' | 'story';
type ChatMessage = { role: 'user' | 'assistant'; content: string };
type UserProfile = { displayName?: string | null };
type AppTheme = 'light' | 'dark';

const LANGUAGE_LABELS: Record<ConversationLanguage, string> = {
  community: 'EBEMBE',
  swahili: 'KIBEMBE',
  english: 'BEMBE',
};

const MODE_LABELS: Record<ConversationMode, string> = {
  chat: 'Ask anything',
  joke: 'Tell a joke',
  story: 'Tell a story',
};

async function readCurrentKnowledge() {
  // Keep every status so the administrator can see the review queue, accepted memory,
  // and trash as separate lists. AI prompts filter this source to verified entries only.
  return knowledgeTable.list({ orderBy: { createdAt: 'desc' }, limit: 100 });
}

async function broadcastKnowledgeChange(action: 'created' | 'edited' | 'verified' | 'rejected', entryId: string) {
  try {
    await blink.realtime.publish('village-voice-knowledge', 'knowledge-updated', {
      action,
      entryId,
      changedAt: Date.now(),
    });
  } catch {
    // The next foreground refresh still keeps the app correct if realtime is unavailable.
  }
}

async function forgetPhraseFromAdminHistory(phrase: string) {
  const normalizedPhrase = phrase.trim().toLocaleLowerCase();
  if (!normalizedPhrase) return;
  const storedMessages = await adminMessagesTable.list({ orderBy: { createdAt: 'asc' }, limit: 100 });
  const matches = storedMessages.filter((message) => message.content.toLocaleLowerCase().includes(normalizedPhrase));
  await Promise.all(matches.map((message) => adminMessagesTable.delete(message.id)));
}

function answerVariations(value: string | null | undefined) {
  return (value ?? '')
    .split(/[|;\n]/)
    .map((answer) => answer.trim())
    .filter(Boolean);
}

function vocabularyContext(entries: VillageVoiceKnowledgeRow[]) {
  const seen = new Set<string>();
  const verified = entries.filter((entry) => {
    const phrase = entry.phrase.trim().toLocaleLowerCase();
    if (entry.status !== 'verified' || !phrase || seen.has(phrase)) return false;
    seen.add(phrase);
    return true;
  });
  const learned = verified.map((entry) => {
    const variations = answerVariations(entry.answerVariations);
    const variationText = variations.length > 0 ? `; approved answer variations: ${variations.join(' / ')}` : '';
    return `${entry.phrase} means ${entry.meaning}${entry.pronunciation ? ` (${entry.pronunciation})` : ''}${variationText}`;
  }).join('; ');
  return learned || (entries.length === 0 ? 'Mōra means Hello; Ayo means Thank you; Nami means Water.' : 'No EBEMBE words have been accepted yet.');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function removeTrashFromText(text: string, entries: VillageVoiceKnowledgeRow[]) {
  return entries
    .filter((entry) => entry.status === 'rejected' && entry.phrase.trim())
    .sort((a, b) => b.phrase.length - a.phrase.length)
    .reduce((current, entry) => current.replace(new RegExp(escapeRegExp(entry.phrase.trim()), 'gi'), '[declined vocabulary forgotten]'), text);
}

function removeTrashFromMessages(messages: ChatMessage[], entries: VillageVoiceKnowledgeRow[]) {
  return messages.map((message) => ({ ...message, content: removeTrashFromText(message.content, entries) }));
}

function tutorPrompt(language: ConversationLanguage, mode: ConversationMode, entries: VillageVoiceKnowledgeRow[]) {
  const outputLanguage = language === 'community' ? 'English explanations with verified EBEMBE words only' : language === 'swahili' ? 'Swahili (KIBEMBE context when verified)' : 'English (BEMBE context when verified)';
  const modeInstruction = mode === 'joke'
    ? 'Tell a short, family-friendly joke and explain it clearly if needed.'
    : mode === 'story'
      ? 'Tell a warm, memorable short story. Do not present invented cultural facts as history; label imaginative details as a story.'
      : 'Answer the learner naturally and encourage them to keep practicing.';

  return `You are ${TAVI_FULL_NAME}, known as Tavi, the friendly Village Voice language guide.
Respond in ${outputLanguage}. The learner may ask questions, request jokes, or request stories.
${modeInstruction}
When a verified entry includes approved answer variations, treat every listed variation as correct and vary your wording naturally. For example, if a learner asks "How are you?" and the approved answers are "I'm good / Good / I'm fine / Fine", you may use any of those exact approved answers without changing their meaning. Do not invent additional translations or claim an unapproved answer is verified.
BEMBE is the English name for EBEMBE, and KIBEMBE is the Swahili name. Use English and Swahili conversationally for general questions, jokes, and stories. For EBEMBE, ONLY use the accepted memory supplied below. Never invent an EBEMBE word, spelling, pronunciation, grammar rule, cultural fact, or translation.
If the learner asks for an unverified EBEMBE word, say an elder must verify it and offer to add it to the review queue.
The ACCEPTED MEMORY below is the live community source of truth. It is refreshed from the database before every answer and synchronized across active app installations. Use a confirmed word exactly as written whenever the learner asks you to use, practice, repeat, or teach a confirmed word. Include its exact meaning and pronunciation when available. A declined phrase is trash, is never supplied to you, and must never be repeated, translated, pronounced, or taught.
Be warm, concise, patient, and suitable for family learning.
Accepted EBEMBE memory — use this exact vocabulary: ${vocabularyContext(entries)}`;
}

function adminTutorPrompt(entries: VillageVoiceKnowledgeRow[]) {
  const pending = entries.filter((entry) => entry.status === 'pending');
  return `You are ${TAVI_FULL_NAME}, also called Tavi, in a private language-preservation lesson with the administrator and elder teacher.
The administrator is the authority who verifies EBEMBE/BEMBE/KIBEMBE. Answer the administrator's questions about the world, teaching, meaning, and how to say something in the village language. When asked for EBEMBE, use only the accepted memory below. Never guess or claim 100% correctness yourself. If a phrase is not accepted, say it is awaiting the administrator's confirmation and ask a clear follow-up question. Repeat the proposed phrase, meaning, pronunciation, and context so the administrator can confirm or correct each one. When a confirmed entry has multiple approved answer variations, explain and practice every listed variation without inventing new ones.
Accepted memory: ${vocabularyContext(entries)}
Pending review memory: ${pending.map((entry) => `${entry.phrase} = ${entry.meaning}`).join('; ') || 'none'}
Trash memory is deliberately omitted. Any phrase the administrator declined has been forgotten immediately and must never be spoken or suggested.`;
}

const words = [
  { native: 'Mōra', meaning: 'Hello', sound: 'MOH-rah' },
  { native: 'Ayo', meaning: 'Thank you', sound: 'AH-yoh' },
  { native: 'Nami', meaning: 'Water', sound: 'NAH-mee' },
];

function impact() {
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : 'The guide could not respond right now.';
}

function capitalizeTypedText(value: string) {
  if (!value) return value;
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const AVATAR_VIDEO_URL = 'https://storage.googleapis.com/blink-core-storage/projects/village-voice-app-kn8pvg1l/ai-videos/1789609115474-5905740c-b34c-4f02-8535-3c46a5e4e7bd.mp4';

function AvatarStage({ isSpeaking }: { isSpeaking: boolean }) {
  const player = useVideoPlayer(AVATAR_VIDEO_URL, (videoPlayer) => {
    videoPlayer.loop = true;
    videoPlayer.muted = true;
    videoPlayer.play();
  });
  const glow = useSharedValue(1);
  const animatedGlow = useAnimatedStyle(() => ({
    opacity: glow.value,
    transform: [{ scale: glow.value }],
  }));

  useEffect(() => {
    glow.value = isSpeaking
      ? withRepeat(withSequence(withTiming(1.08, { duration: 420 }), withTiming(1, { duration: 420 })), -1, true)
      : withTiming(1, { duration: 180 });
  }, [glow, isSpeaking]);

  return (
    <YStack alignItems="center" gap="$2">
      <YStack width={170} height={192} alignItems="center" justifyContent="center" position="relative">
        <YStack position="absolute" width={170} height={192} borderRadius="$6" backgroundColor={isSpeaking ? '#F4C66A' : '#D9EAD3'} opacity={0.55}>
          <YStack width={170} height={192} />
        </YStack>
        <YStack style={animatedGlow} width={154} height={176} borderRadius="$5" overflow="hidden" backgroundColor="#F5EBDD" position="relative" elevation={isSpeaking ? 8 : 2}>
          <ExpoImage
            source={{ uri: AVATAR_URL }}
            contentFit="cover"
            transition={200}
            onError={() => undefined}
            style={{ position: 'absolute', width: 154, height: 176, left: 0, top: 0, zIndex: 1 }}
          />
          <VideoView
            player={player}
            style={{ position: 'absolute', width: 154, height: 176, left: 0, top: 0, zIndex: 2 }}
            contentFit="cover"
            nativeControls={false}
          />
        </YStack>
      </YStack>
      <XStack alignItems="center" gap="$2">
        <YStack width={8} height={8} borderRadius="$10" backgroundColor={isSpeaking ? '#E79A5A' : '#5F936A'} />
        <SizableText size="$2" color="#8A542B" fontWeight="700">{isSpeaking ? 'Tavi is speaking' : 'Tavi is listening'}</SizableText>
      </XStack>
    </YStack>
  );
}

function StudioVideoPreview({ url, index, onDownload }: { url: string; index: number; onDownload: (url: string, index: number) => void }) {
  const player = useVideoPlayer(url, (videoPlayer) => {
    videoPlayer.loop = true;
    videoPlayer.muted = false;
    videoPlayer.play();
  });

  return (
    <YStack gap="$2" width="100%">
      <SizableText size="$2" color="#8A542B" fontWeight="800">SCENE {index + 1} · 12 SECONDS</SizableText>
      <YStack height={230} borderRadius="$5" overflow="hidden" backgroundColor="#24362B">
        <VideoView player={player} style={{ width: '100%', height: 230 }} contentFit="contain" nativeControls />
      </YStack>
      <Button height={44} backgroundColor="#F4C66A" borderRadius="$3" onPress={() => onDownload(url, index)}>
        <SizableText color="#24362B" fontWeight="900">Download scene {index + 1}</SizableText>
      </Button>
    </YStack>
  );
}

async function speakWithAvatar(text: string) {
  const token = await blink.auth.getValidToken();
  if (!token) throw new Error('Sign in to hear Tavi speak.');
  const { url } = await blink.ai.generateSpeech({ text, voice: 'nova' });
  if (Platform.OS === 'web') {
    const audio = new Audio(url);
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('Tavi audio could not be played.'));
      void audio.play().catch(reject);
    });
    return;
  }
  const { sound } = await ExpoAudio.Sound.createAsync({ uri: url });
  await new Promise<void>((resolve, reject) => {
    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) {
        if (status.error) reject(new Error(status.error));
        return;
      }
      if (status.didJustFinish) {
        void sound.unloadAsync();
        resolve();
      }
    });
    void sound.playAsync().catch(reject);
  });
}

export default function Home() {
  const [heard, setHeard] = useState<string | null>(null);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [freeUsesUsed, setFreeUsesUsed] = useState(0);
  const [coinNotice, setCoinNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [question, setQuestion] = useState('');
  const [conversationLanguage, setConversationLanguage] = useState<ConversationLanguage>('english');
  const [conversationMode, setConversationMode] = useState<ConversationMode>('chat');
  const [isThinking, setIsThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [tutorError, setTutorError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminEntries, setAdminEntries] = useState<VillageVoiceKnowledgeRow[]>([]);
  const [adminMessages, setAdminMessages] = useState<ChatMessage[]>([]);
  const [adminQuestion, setAdminQuestion] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [adminSpeakingId, setAdminSpeakingId] = useState<string | null>(null);
  const [adminTyping, setAdminTyping] = useState(false);
  const [adminActionId, setAdminActionId] = useState<string | null>(null);
  const [studioPrompt, setStudioPrompt] = useState('');
  const [studioAttachment, setStudioAttachment] = useState<{ url: string; name: string; kind: 'photo' | 'video' } | null>(null);
  const [studioAnalysis, setStudioAnalysis] = useState<string | null>(null);
  const [studioVideos, setStudioVideos] = useState<string[]>([]);
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioProgress, setStudioProgress] = useState(0);
  const [studioUnlocked, setStudioUnlocked] = useState(false);
  const [studioNotice, setStudioNotice] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [studioDownloadBusy, setStudioDownloadBusy] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile>({});
  const [profileName, setProfileName] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [appTheme, setAppTheme] = useState<AppTheme>('light');
  const [coinBalance, setCoinBalance] = useState(0);
  const [coinBalanceLoading, setCoinBalanceLoading] = useState(false);
  const [coinBalanceError, setCoinBalanceError] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [adminEntryForm, setAdminEntryForm] = useState({ phrase: '', meaning: '', pronunciation: '', context: '', answerVariations: '' });
  const [adminEditForm, setAdminEditForm] = useState({ phrase: '', meaning: '', pronunciation: '', context: '', answerVariations: '' });
  const isAdminRef = useRef(false);
  const browserRecorderRef = useRef<MediaRecorder | null>(null);
  const nativeRecorderRef = useRef<ExpoAudio.Recording | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: AVATAR_GREETING },
  ]);
  const { packages: coinPackages, isLoading: coinMarketLoading, error: coinMarketError, refresh: refreshCoinMarket } = useCoinMarket(isSignedIn);

  useEffect(() => {
    const unsubscribe = blink.auth.onAuthStateChanged((state) => {
      setIsSignedIn(Boolean(state.user));
      setCurrentUserId(state.user?.id ?? null);
      if (state.user) {
        const nextProfile = { displayName: state.user.displayName };
        setProfile(nextProfile);
        setProfileName(state.user.displayName || '');
        void AsyncStorage.getItem(`${FREE_AI_USES_KEY}-${state.user.id}`).then((saved) => {
          setFreeUsesUsed(Math.min(FREE_AI_USES, Number(saved) || 0));
        });
      } else {
        setProfile({});
        setProfileName('');
        setFreeUsesUsed(0);
      }
      if (!state.isLoading) setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    void AsyncStorage.getItem('village-voice-theme').then((savedTheme) => {
      if (savedTheme === 'dark' || savedTheme === 'light') setAppTheme(savedTheme);
    });
  }, []);

  useEffect(() => {
    void identifyRevenueCatUser(currentUserId);
  }, [currentUserId]);

  useEffect(() => {
    let cancelled = false;
    if (!currentUserId) {
      setCoinBalance(0);
      setCoinBalanceError(null);
      setCoinBalanceLoading(false);
      return () => { cancelled = true; };
    }
    setCoinBalanceLoading(true);
    setCoinBalanceError(null);
    void coinBalancesTable.list({ where: { userId: currentUserId }, limit: 1 })
      .then((rows) => {
        if (!cancelled) setCoinBalance(Number(rows[0]?.coins ?? 0));
      })
      .catch((error) => {
        if (!cancelled) setCoinBalanceError(readableError(error));
      })
      .finally(() => {
        if (!cancelled) setCoinBalanceLoading(false);
      });
    return () => { cancelled = true; };
  }, [currentUserId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entries = await readCurrentKnowledge();
        if (cancelled) return;
        setAdminEntries(entries);
        if (!isSignedIn) {
          setIsAdmin(false);
          isAdminRef.current = false;
          setAdminMessages([]);
          return;
        }
        const user = await blink.auth.me();
        const admin = user?.id === ADMIN_USER_ID;
        setIsAdmin(admin);
        isAdminRef.current = admin;
        if (!admin) return;
        const messages = await adminMessagesTable.list({ orderBy: { createdAt: 'asc' }, limit: 100 });
        if (!cancelled) {
          setAdminMessages(messages.map((message) => ({ role: message.role === 'admin' ? 'user' : 'assistant', content: message.content })));
        }
      } catch (error) {
        if (!cancelled) setAdminNotice(readableError(error));
      }
    })();
    return () => { cancelled = true; };
  }, [isSignedIn]);

  useEffect(() => {
    let mounted = true;
    let channel: ReturnType<typeof blink.realtime.channel> | null = null;
    const refreshKnowledge = () => {
      void readCurrentKnowledge().then((entries) => {
        if (mounted) setAdminEntries(entries);
      }).catch(() => undefined);
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshKnowledge();
    });
    refreshKnowledge();
    const refreshTimer = setInterval(refreshKnowledge, 5000);
    if (isSignedIn && currentUserId) {
      void (async () => {
        try {
          const nextChannel = blink.realtime.channel('village-voice-knowledge');
          channel = nextChannel;
          await nextChannel.subscribe({ userId: currentUserId });
          if (!mounted) return;
          nextChannel.onMessage((message) => {
            if (message.type === 'knowledge-updated') refreshKnowledge();
          });
        } catch {
          // Database reads remain the fallback for guests and offline sessions.
        }
      })();
    }
    return () => {
      mounted = false;
      appStateSubscription.remove();
      clearInterval(refreshTimer);
      if (channel) void channel.unsubscribe();
    };
  }, [currentUserId, isSignedIn]);

  const chooseAnswer = (answer: string) => {
    impact();
    setSelected(answer);
  };

  const buyCoinPackage = async (packageIndex: number) => {
    const packageToBuy = coinPackages[packageIndex];
    if (!packageToBuy) return;
    impact();
    setCoinNotice(null);
    try {
      const result = await purchaseCoinPackage(packageToBuy);
      const coins = packageIndex === 0 ? 100 : packageIndex === 1 ? 500 : 1200;
      setCoinNotice(`${coins.toLocaleString()} coins purchased. Your balance will update after the secure receipt is confirmed.`);
      if (result.customerInfo) {
        await refreshCoinMarket();
        setTimeout(() => {
          void coinBalancesTable.list({ where: { userId: currentUserId ?? '' }, limit: 1 })
            .then((rows) => setCoinBalance(Number(rows[0]?.coins ?? 0)))
            .catch(() => undefined);
        }, 1000);
      }
    } catch (error) {
      setCoinNotice(readableError(error));
    }
  };

  const restoreCoins = async () => {
    impact();
    try {
      await restoreCoinPurchases();
      setCoinNotice('Your purchases have been restored.');
    } catch (error) {
      setCoinNotice(readableError(error));
    }
  };

  const saveProfile = async () => {
    const name = profileName.trim();
    if (!name) {
      setProfileNotice('Enter a display name first.');
      return;
    }
    setProfileBusy(true);
    setProfileNotice(null);
    try {
      await blink.auth.updateMe({ displayName: name });
      setProfile((current) => ({ ...current, displayName: name }));
      setProfileNotice('Your profile name was saved.');
    } catch (error) {
      setProfileNotice(readableError(error));
    } finally {
      setProfileBusy(false);
    }
  };

  const toggleAppTheme = async () => {
    const nextTheme: AppTheme = appTheme === 'light' ? 'dark' : 'light';
    setAppTheme(nextTheme);
    await AsyncStorage.setItem('village-voice-theme', nextTheme);
  };

  const downloadStudioVideo = async (url: string, index: number) => {
    if (!isSignedIn) {
      setStudioError('Sign in to download your Tavi video.');
      return;
    }
    setStudioDownloadBusy(true);
    setStudioError(null);
    try {
      if (Platform.OS === 'web') {
        const link = document.createElement('a');
        link.href = url;
        link.download = `village-voice-tavi-scene-${index + 1}.mp4`;
        link.target = '_blank';
        link.rel = 'noreferrer';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setStudioNotice(`Scene ${index + 1} download started.`);
        return;
      }
      const destination = `${FileSystem.cacheDirectory || ''}village-voice-tavi-scene-${index + 1}.mp4`;
      const downloaded = await FileSystem.downloadAsync(url, destination);
      const mediaPermission = await MediaLibrary.requestPermissionsAsync();
      if (mediaPermission.granted) {
        await MediaLibrary.saveToLibraryAsync(downloaded.uri);
        setStudioNotice(`Scene ${index + 1} was saved to your device gallery.`);
      } else if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(downloaded.uri, { mimeType: 'video/mp4', dialogTitle: 'Save your Tavi story' });
        setStudioNotice(`Scene ${index + 1} is ready to save or share.`);
      } else {
        throw new Error('Allow photo and video access to save this scene to your device.');
      }
    } catch (error) {
      setStudioError(readableError(error));
    } finally {
      setStudioDownloadBusy(false);
    }
  };

  const unlockStudio = async () => {
    if (!isSignedIn) {
      setStudioError('Sign in before unlocking Tavi Story Studio.');
      return;
    }
    setStudioError(null);
    setStudioNotice(null);
    try {
      if (!coinPackages[STUDIO_PACK_INDEX]) throw new Error('The 500-coin Story Studio pack is not available yet.');
      await buyCoinPackage(STUDIO_PACK_INDEX);
      setStudioUnlocked(true);
      setStudioNotice('Story Studio unlocked with the 500-coin premium pack.');
    } catch (error) {
      setStudioError(readableError(error));
    }
  };

  const pickStudioAttachment = async () => {
    if (!isSignedIn) {
      setStudioError('Sign in before uploading a photo or video for Tavi.');
      return;
    }
    setStudioError(null);
    setStudioNotice(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        quality: 0.9,
        allowsEditing: false,
      });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      const fileName = asset.fileName || asset.uri.split('/').pop() || `studio-${Date.now()}`;
      const extension = fileName.split('.').pop() || (asset.type === 'video' ? 'mp4' : 'jpg');
      const uploadable = Platform.OS === 'web' && asset.file ? asset.file : new File(asset.uri);
      const uploaded = await blink.storage.upload(uploadable, `studio/${Date.now()}-${fileName}.${extension}`);
      const kind = asset.type === 'video' ? 'video' : 'photo';
      setStudioAttachment({ url: uploaded.publicUrl, name: fileName, kind });
      if (kind === 'photo') {
        const response = await blink.ai.generateText({
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'You are Tavi, a village-language preservation assistant. Describe this reference photo in a short production brief for a family-friendly 45–60 second EBEMBE story video. Do not invent EBEMBE words. Keep the spoken language EBEMBE only where verified, with a little clear Swahili if needed.' },
              { type: 'image', image: uploaded.publicUrl },
            ],
          }],
        });
        setStudioAnalysis(response.text);
      } else {
        setStudioAnalysis('Video reference received. Tavi will use your written brief and this reference to shape the story scenes.');
      }
      setStudioNotice(`${kind === 'photo' ? 'Photo' : 'Video'} uploaded. Tavi recognized the reference and is ready to create.`);
    } catch (error) {
      setStudioError(readableError(error));
    }
  };

  const createStudioStory = async () => {
    if (!isSignedIn) {
      setStudioError('Sign in before creating a Tavi story video.');
      return;
    }
    if (!studioUnlocked) {
      setStudioError('Unlock Story Studio with the 500-coin premium pack before generating.');
      return;
    }
    const brief = studioPrompt.trim() || 'Create a warm village story that teaches a simple greeting to a learner.';
    setStudioBusy(true);
    setStudioProgress(0);
    setStudioError(null);
    setStudioNotice('Tavi is preparing a four-scene story in EBEMBE with a little Swahili.');
    setStudioVideos([]);
    try {
      const currentKnowledge = await readCurrentKnowledge();
      setAdminEntries(currentKnowledge);
      const verifiedWords = vocabularyContext(currentKnowledge);
      const reference = studioAnalysis ? `Reference understanding: ${studioAnalysis}` : studioAttachment ? `A ${studioAttachment.kind} reference was attached at ${studioAttachment.url}.` : 'No media reference was attached.';
      const sceneDirections = [
        'Open with a natural village welcome: gentle eye contact, blinking, breathing, head movement, and a clear greeting.',
        'Show Tavi demonstrating the key word with expressive hands and a warm teaching gesture.',
        'Show a learner responding while Tavi listens, nods, smiles, and moves naturally.',
        'Close with Tavi repeating the phrase slowly and clearly, then invite the learner to practice.',
      ];
      for (let index = 0; index < STUDIO_CLIP_COUNT; index += 1) {
        const response = await blink.ai.generateVideo({
          model: 'fal-ai/veo3.1/fast',
          duration: '12s',
          aspect_ratio: '9:16',
          generate_audio: true,
          prompt: `Create scene ${index + 1} of a connected 48-second Village Voice language lesson featuring Gloire Sadiki, called Tavi. ${sceneDirections[index]} User request: ${brief}. ${reference} Spoken audio must be slow, clear, human-like, and use EBEMBE only from these verified entries: ${verifiedWords}. Use only a little simple Swahili for transitions when needed. Never invent an EBEMBE translation, pronunciation, grammar rule, or cultural fact. Tavi must visibly blink, breathe, move the head and hands, and speak with natural mouth and tongue movement. Keep the same character, clothing, lighting, village setting, and voice across all scenes.`,
          negative_prompt: 'frozen face, blank stare, no blinking, stiff body, lip-sync mismatch, distorted mouth, invented language words, subtitles with misspellings, unsafe content',
        });
        setStudioVideos((current) => [...current, response.result.video.url]);
        setStudioProgress(Math.round(((index + 1) / STUDIO_CLIP_COUNT) * 100));
      }
      setStudioNotice('Your 48-second four-scene Tavi story is ready. Play each connected scene to review the movement, blinking, audio, and language before sharing.');
    } catch (error) {
      setStudioError(readableError(error));
    } finally {
      setStudioBusy(false);
    }
  };

  const signInWithGoogle = async () => {
    impact();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await blink.auth.signInWithGoogle();
    } catch (error) {
      setAuthError(readableError(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const switchAccount = async () => {
    impact();
    setAuthBusy(true);
    setAuthError(null);
    try {
      await blink.auth.signOut();
      await blink.auth.signInWithGoogle();
    } catch (error) {
      setAuthError(readableError(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const playAvatar = async (text: string) => {
    impact();
    if (!isSignedIn) {
      setAuthError('Continue with Google to let Tavi speak with you.');
      await signInWithGoogle();
      return;
    }
    setIsSpeaking(true);
    setTutorError(null);
    try {
      await speakWithAvatar(text);
    } catch (error) {
      setTutorError(readableError(error));
    } finally {
      setIsSpeaking(false);
    }
  };

  const consumeCoin = async () => {
    if (!currentUserId) return false;
    const rows = await coinBalancesTable.list({ where: { userId: currentUserId }, limit: 1 });
    const balance = rows[0];
    const available = Number(balance?.coins ?? coinBalance);
    if (!balance || available < AI_COIN_COST) return false;
    await coinBalancesTable.update(balance.id, { coins: available - AI_COIN_COST, updatedAt: new Date().toISOString() });
    setCoinBalance(available - AI_COIN_COST);
    return true;
  };

  const markFreeUse = async () => {
    const next = Math.min(FREE_AI_USES, freeUsesUsed + 1);
    setFreeUsesUsed(next);
    if (currentUserId) await AsyncStorage.setItem(`${FREE_AI_USES_KEY}-${currentUserId}`, String(next));
  };

  const askGuide = async (promptOverride?: string) => {
    const trimmedQuestion = (promptOverride ?? question).trim();
    if (!trimmedQuestion || isThinking) return;
    if (!isSignedIn) {
      setAuthError('Continue with Google to send your question to Tavi.');
      await signInWithGoogle();
      return;
    }
    if (freeUsesUsed >= FREE_AI_USES && !coinBalanceLoading && coinBalance < AI_COIN_COST) {
      setCoinNotice('You used your two free answers. Add coins to continue speaking with Tavi.');
      setWalletOpen(true);
      return;
    }
    impact();
    setQuestion('');
    setTutorError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: trimmedQuestion }];
    setMessages(nextMessages);
    setIsThinking(true);
    try {
      const currentKnowledge = await readCurrentKnowledge();
      setAdminEntries(currentKnowledge);
      const safeMessages = removeTrashFromMessages(nextMessages, currentKnowledge);
      const response = await blink.ai.generateText({
        messages: [
          { role: 'system', content: tutorPrompt(conversationLanguage, conversationMode, currentKnowledge) },
          ...safeMessages.map((message) => ({ role: message.role, content: message.content })),
        ],
      });
      const safeResponse = removeTrashFromText(response.text, currentKnowledge);
      if (freeUsesUsed < FREE_AI_USES) {
        await markFreeUse();
      } else if (!(await consumeCoin())) {
        setCoinNotice('You need 1 coin to continue. Open Wallet to add coins.');
        setWalletOpen(true);
        throw new Error('Payment required.');
      }
      setMessages((current) => [...current, { role: 'assistant', content: safeResponse }]);
      await playAvatar(safeResponse);
    } catch (error) {
      if (!(error instanceof Error && error.message === 'Payment required')) {
        setTutorError(readableError(error));
      }
    } finally {
      setIsThinking(false);
    }
  };

  const confirmKnowledgeEntry = async (entry: VillageVoiceKnowledgeRow, status: 'verified' | 'rejected') => {
    if (adminActionId) return;
    setAdminActionId(entry.id);
    setAdminNotice(null);
    try {
      const now = new Date().toISOString();
      if (status === 'rejected') {
        const rejected = await knowledgeTable.update(entry.id, { status: 'rejected', reviewerNote: 'Declined by administrator — stored in trash and excluded from AI memory', updatedAt: now });
        setEditingEntryId(null);
        setAdminEntries((current) => [rejected, ...current.filter((item) => item.id !== rejected.id)]);
        setMessages((current) => removeTrashFromMessages(current, [rejected]));
        setAdminNotice(`${entry.phrase} was removed from the review queue and moved to Trash. Tavi will never use it as language memory.`);
        void readCurrentKnowledge().then(setAdminEntries).catch(() => undefined);
        void broadcastKnowledgeChange('rejected', rejected.id);
        void forgetPhraseFromAdminHistory(entry.phrase).catch(() => undefined);
        return;
      }
      const updated = await knowledgeTable.update(entry.id, { status: 'verified', reviewerNote: 'Confirmed by administrator — permanent accepted memory', updatedAt: now });
      setEditingEntryId(null);
      setAdminEntries((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
      setAdminNotice(`${entry.phrase} was removed from the review queue and moved to AI Memory. Tavi will use it in the next answer and future lessons.`);
      void readCurrentKnowledge().then(setAdminEntries).catch(() => undefined);
      void broadcastKnowledgeChange('verified', updated.id);
    } catch (error) {
      setAdminNotice(readableError(error));
    } finally {
      setAdminActionId(null);
    }
  };

  const hearKnowledgeEntry = async (entry: VillageVoiceKnowledgeRow) => {
    impact();
    setAdminSpeakingId(entry.id);
    setAdminNotice(null);
    try {
      const pronunciation = entry.pronunciation || 'No pronunciation has been confirmed yet.';
      await speakWithAvatar(`The village-language phrase is ${entry.phrase}. Say it as: ${pronunciation}. It means: ${entry.meaning}. ${entry.context || ''}`);
      setAdminNotice(`Tavi read “${entry.phrase}”. Confirm the sound and wording before marking it verified.`);
    } catch (error) {
      setAdminNotice(readableError(error));
    } finally {
      setAdminSpeakingId(null);
    }
  };

  const beginEditKnowledgeEntry = (entry: VillageVoiceKnowledgeRow) => {
    setEditingEntryId(entry.id);
    setAdminEditForm({ phrase: entry.phrase, meaning: entry.meaning, pronunciation: entry.pronunciation || '', context: entry.context || '', answerVariations: entry.answerVariations || '' });
  };

  const approveEditedKnowledgeEntry = async (entry: VillageVoiceKnowledgeRow) => {
    if (!adminEditForm.phrase.trim() || !adminEditForm.meaning.trim()) {
      setAdminNotice('Add a phrase and meaning before approving.');
      return;
    }
    setAdminActionId(entry.id);
    setAdminNotice(null);
    try {
      const now = new Date().toISOString();
      const approved = await knowledgeTable.update(entry.id, {
        phrase: capitalizeTypedText(adminEditForm.phrase.trim()),
        meaning: capitalizeTypedText(adminEditForm.meaning.trim()),
        pronunciation: adminEditForm.pronunciation.trim() || null,
        context: adminEditForm.context.trim() || null,
        answerVariations: adminEditForm.answerVariations.trim() || null,
        status: 'verified',
        reviewerNote: 'Approved by administrator — permanent accepted memory',
        updatedAt: now,
      });
      setAdminEntries((current) => [approved, ...current.filter((item) => item.id !== approved.id)]);
      setEditingEntryId(null);
      setAdminNotice(`${approved.phrase} was approved and moved to AI Memory. Tavi can use it now.`);
      void broadcastKnowledgeChange('verified', approved.id);
    } catch (error) {
      setAdminNotice(readableError(error));
    } finally {
      setAdminActionId(null);
    }
  };

  const saveKnowledgeEntry = async (entry: VillageVoiceKnowledgeRow) => {
    if (!adminEditForm.phrase.trim() || !adminEditForm.meaning.trim()) {
      setAdminNotice('Add a phrase and meaning before saving.');
      return;
    }
    setAdminActionId(entry.id);
    try {
      const updated = await knowledgeTable.update(entry.id, {
        phrase: capitalizeTypedText(adminEditForm.phrase.trim()),
        meaning: capitalizeTypedText(adminEditForm.meaning.trim()),
        pronunciation: adminEditForm.pronunciation.trim() || null,
        context: adminEditForm.context.trim() || null,
        answerVariations: adminEditForm.answerVariations.trim() || null,
        status: 'pending',
        reviewerNote: 'Edited by administrator — awaiting confirmation',
        updatedAt: new Date().toISOString(),
      });
      const refreshedEntries = await readCurrentKnowledge();
      setAdminEntries(refreshedEntries.map((item) => item.id === updated.id ? updated : item));
      setEditingEntryId(null);
      setAdminNotice('Word updated and returned to pending review. Hear it, then confirm it again.');
      void broadcastKnowledgeChange('edited', updated.id);
    } catch (error) {
      setAdminNotice(readableError(error));
    } finally {
      setAdminActionId(null);
    }
  };

  const transcribeAudioInput = async (audio: string) => {
    setIsTranscribing(true);
    setTutorError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(TRANSCRIPTION_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio, language: conversationLanguage === 'swahili' ? 'sw' : 'en' }),
        signal: controller.signal,
      });
      const payload = await response.json() as { text?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || 'Audio transcription failed.');
      if (!payload.text?.trim()) throw new Error('Tavi could not hear that recording. Please try again.');
      await askGuide(payload.text.trim());
    } catch (error) {
      setTutorError(error instanceof DOMException && error.name === 'AbortError' ? 'Audio transcription took too long. Please record a shorter question.' : readableError(error));
    } finally {
      clearTimeout(timeout);
      setIsTranscribing(false);
    }
  };

  const stopRecording = async () => {
    if (Platform.OS === 'web') {
      const recorder = browserRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        setIsRecording(false);
        return;
      }
      recorder.stop();
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      setIsRecording(false);
      return;
    }

    const recording = nativeRecorderRef.current;
    if (!recording) {
      setIsRecording(false);
      return;
    }
    try {
      await recording.stopAndUnloadAsync();
      nativeRecorderRef.current = null;
      const uri = recording.getURI();
      if (!uri) throw new Error('The recording did not produce an audio file.');
      const audio = await new File(uri).base64();
      if (!audio) throw new Error('The recording was empty. Please try again.');
      await transcribeAudioInput(audio);
    } catch (error) {
      setTutorError(readableError(error));
      setIsTranscribing(false);
    } finally {
      setIsRecording(false);
      await ExpoAudio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => undefined);
    }
  };

  const startRecording = async () => {
    if (isRecording || isTranscribing) return;
    if (!isSignedIn && freeUsesUsed >= FREE_AI_USES) {
      setAuthError('Your two free questions are used. Continue with Google to keep learning with Tavi.');
      await signInWithGoogle();
      return;
    }
    if (isSignedIn && freeUsesUsed >= FREE_AI_USES && coinBalance < AI_COIN_COST) {
      setCoinNotice('Add coins in Wallet before recording another question.');
      setWalletOpen(true);
      return;
    }
    setTutorError(null);
    try {
      if (Platform.OS !== 'web') {
        const permission = await ExpoAudio.requestPermissionsAsync();
        if (!permission.granted) {
          setTutorError('Allow microphone access in your phone settings to speak with Tavi.');
          return;
        }
        await ExpoAudio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const recording = new ExpoAudio.Recording();
        await recording.prepareToRecordAsync(ExpoAudio.RecordingOptionsPresets.HIGH_QUALITY);
        await recording.startAsync();
        nativeRecorderRef.current = recording;
        setIsRecording(true);
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        setTutorError('This browser does not support microphone questions.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordingStreamRef.current = stream;
      browserRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        try {
          const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          if (blob.size === 0) throw new Error('The recording was empty. Please try again.');
          await transcribeAudioInput(await blobToBase64(blob));
        } catch (error) {
          setTutorError(readableError(error));
          setIsTranscribing(false);
        } finally {
          recordingChunksRef.current = [];
          browserRecorderRef.current = null;
          recordingStreamRef.current = null;
        }
      };
      recorder.start();
      setIsRecording(true);
    } catch (error) {
      setTutorError(readableError(error));
      setIsRecording(false);
    }
  };

  useEffect(() => () => {
    browserRecorderRef.current?.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    const recording = nativeRecorderRef.current;
    if (recording) void recording.stopAndUnloadAsync();
  }, []);

  const pendingAdminEntries = adminEntries.filter((entry) => entry.status === 'pending');
  const memoryEntries = adminEntries.filter((entry) => entry.status === 'verified');
  const trashEntries = adminEntries.filter((entry) => entry.status === 'rejected');
  const reviewEntries = [
    ...pendingAdminEntries,
    ...adminEntries.filter((entry) => entry.id === editingEntryId && entry.status !== 'pending'),
  ];

  return (
    <YStack flex={1} backgroundColor={appTheme === 'dark' ? '#101812' : '#F7F4EC'}>
      <ScrollView contentContainerStyle={{ paddingBottom: 36 }}>
        <YStack paddingHorizontal="$4" paddingTop="$5" gap="$5" maxWidth={420} width="100%" alignSelf="center">
          {isSignedIn && !authLoading && (
            <Card backgroundColor={appTheme === 'dark' ? '#1B2A20' : '#FFFDF7'} borderColor={appTheme === 'dark' ? '#42634B' : '#D8C7B0'} borderWidth={1} borderRadius="$5" padding="$4" gap="$3">
              <XStack alignItems="center" justifyContent="space-between" gap="$3">
                <YStack flex={1} gap="$1">
                  <SizableText size="$2" color="#C97935" fontWeight="900">YOUR ACCOUNT</SizableText>
                  <H3 color={appTheme === 'dark' ? '#FFFDF7' : '#24362B'}>{profile.displayName || 'Village Voice learner'}</H3>
                  <SizableText size="$2" color={appTheme === 'dark' ? '#C9E3C5' : '#667066'}>Manage your profile and reading mode.</SizableText>
                </YStack>
                <Button height={44} paddingHorizontal="$3" backgroundColor="#315C45" borderRadius="$4" onPress={() => void toggleAppTheme()}>
                  <SizableText color="#FFFDF7" fontWeight="800">{appTheme === 'dark' ? 'White mode' : 'Black mode'}</SizableText>
                </Button>
              </XStack>
              <XStack alignItems="center" gap="$2">
                <Input flex={1} height={48} value={profileName} onChangeText={setProfileName} placeholder="Your display name" backgroundColor={appTheme === 'dark' ? '#24362B' : '#F7F4EC'} borderColor={appTheme === 'dark' ? '#50755D' : '#E7E1D3'} borderRadius="$4" color={appTheme === 'dark' ? '#FFFDF7' : '#24362B'} />
                <Button height={48} backgroundColor="#E79A5A" borderRadius="$4" onPress={() => void saveProfile()} disabled={profileBusy}>
                  <SizableText color="#FFFDF7" fontWeight="800">{profileBusy ? 'Saving…' : 'Save'}</SizableText>
                </Button>
              </XStack>
              {profileNotice && <SizableText size="$2" color={profileNotice.includes('saved') ? '#5F936A' : '#B45C4A'}>{profileNotice}</SizableText>}
            </Card>
          )}
          <XStack alignItems="center" justifyContent="space-between">
            <XStack alignItems="center" gap="$2">
              <YStack backgroundColor="#315C45" borderRadius="$4" padding="$2">
                <Leaf size={20} color="#F7F4EC" />
              </YStack>
              <YStack>
                <SizableText size="$3" fontWeight="800" color={appTheme === 'dark' ? '#F4C66A' : '#315C45'}>VILLAGE VOICE</SizableText>
                <SizableText size="$2" color={appTheme === 'dark' ? '#C9E3C5' : '#7B8177'}>Learn it. Keep it living.</SizableText>
              </YStack>
            </XStack>
            {isSignedIn && (
              <XStack alignItems="center" gap="$2" backgroundColor="#FFF1D1" paddingHorizontal="$3" paddingVertical="$2" borderRadius="$10">
                <Flame size={17} color="#C97935" fill="#C97935" />
                <SizableText fontWeight="800" color="#8A542B">7 day streak</SizableText>
              </XStack>
            )}
          </XStack>

          <YStack gap="$2">
            <SizableText size="$3" color="#7B8177">GOOD MORNING, {profile.displayName || 'AMARA'}</SizableText>
            <H1 color={appTheme === 'dark' ? '#FFFDF7' : '#24362B'} fontSize={34} lineHeight={40}>Keep your language close.</H1>
            <Paragraph color={appTheme === 'dark' ? '#C9E3C5' : '#667066'} size="$4">A few minutes today keeps a whole story alive.</Paragraph>
          </YStack>

          <Card backgroundColor="#E9D9C4" borderRadius="$6" padding="$4" borderWidth={0} overflow="hidden">
            <XStack alignItems="flex-end" gap="$4">
              <AvatarStage isSpeaking={isSpeaking} />
              <YStack flex={1} gap="$2" paddingBottom="$2">
                <XStack alignItems="center" gap="$2"><MessageCircle size={17} color="#8A542B" /><SizableText size="$3" color="#8A542B" fontWeight="800">YOUR LANGUAGE GUIDE</SizableText></XStack>
                <H2 color="#573E2A" fontSize={24}>Meet Tavi</H2>
                <SizableText size="$1" color="#8A542B" fontWeight="700" maxWidth={190}>{TAVI_FULL_NAME}</SizableText>
                <Paragraph color="#765F4B" size="$3">Ask a question and Tavi will answer using verified community words.</Paragraph>
                  <Button height={46} alignSelf="flex-start" backgroundColor="#315C45" borderRadius="$4" onPress={() => void playAvatar(AVATAR_GREETING)} disabled={isSpeaking || !isSignedIn}>
                  {isSpeaking ? <SizableText color="#FFFDF7" fontWeight="800">Speaking…</SizableText> : <><Play size={16} color="#FFFDF7" /><SizableText color="#FFFDF7" fontWeight="800">Hear greeting</SizableText></>}
                </Button>
              </YStack>
            </XStack>
            <YStack marginTop="$4" gap="$3">
              <XStack gap="$2" flexWrap="wrap">
                {(Object.keys(LANGUAGE_LABELS) as ConversationLanguage[]).map((language) => (
                  <Button key={language} height={38} paddingHorizontal="$3" borderRadius="$10" backgroundColor={conversationLanguage === language ? '#315C45' : '#F5EBDD'} onPress={() => setConversationLanguage(language)}>
                    <SizableText size="$2" color={conversationLanguage === language ? '#FFFDF7' : '#573E2A'} fontWeight="700">{LANGUAGE_LABELS[language]}</SizableText>
                  </Button>
                ))}
              </XStack>
              <XStack gap="$2" flexWrap="wrap">
                {(Object.keys(MODE_LABELS) as ConversationMode[]).map((mode) => (
                  <Button key={mode} height={38} paddingHorizontal="$3" borderRadius="$10" backgroundColor={conversationMode === mode ? '#E79A5A' : '#F5EBDD'} onPress={() => setConversationMode(mode)}>
                    <SizableText size="$2" color={conversationMode === mode ? '#FFFDF7' : '#573E2A'} fontWeight="700">{MODE_LABELS[mode]}</SizableText>
                  </Button>
                ))}
              </XStack>
              {messages.slice(-3).map((message, index) => (
                <XStack key={`${message.role}-${index}`} justifyContent={message.role === 'user' ? 'flex-end' : 'flex-start'}>
                  <YStack maxWidth="88%" backgroundColor={message.role === 'user' ? '#315C45' : '#FFFDF7'} borderRadius="$4" padding="$3">
                    <SizableText color={message.role === 'user' ? '#FFFDF7' : '#573E2A'}>{message.content}</SizableText>
                  </YStack>
                </XStack>
              ))}
              <SizableText size="$2" color="#8A542B">{isSignedIn ? `Free AI answers: ${Math.max(0, FREE_AI_USES - freeUsesUsed)}/${FREE_AI_USES} · then ${AI_COIN_COST} coin per answer.` : `Free AI answers: ${Math.max(0, FREE_AI_USES - freeUsesUsed)}/${FREE_AI_USES} · after that, Continue with Google.`}</SizableText>
              {isThinking && <SizableText color="#8A542B">Tavi is thinking in {LANGUAGE_LABELS[conversationLanguage]}…</SizableText>}
              {isTranscribing && <SizableText color="#8A542B">Tavi is listening to your question…</SizableText>}
              <XStack alignItems="center" gap="$2">
                <Input flex={1} height={48} value={question} onChangeText={(value) => setQuestion(capitalizeTypedText(value))} autoCapitalize="sentences" placeholder={`Ask Tavi in ${LANGUAGE_LABELS[conversationLanguage]}…`} backgroundColor="#FFFDF7" borderColor="#D8C7B0" borderRadius="$4" color="#24362B" onSubmitEditing={() => askGuide()} />
                <Button circular size="$5" backgroundColor={isRecording ? '#B45C4A' : '#E79A5A'} onPress={isRecording ? stopRecording : startRecording} disabled={isThinking || isTranscribing} aria-label={isRecording ? 'Stop microphone recording' : 'Microphone — ask by voice'} accessibilityLabel={isRecording ? 'Stop microphone recording' : 'Microphone — ask by voice'} accessibilityRole="button">
                  {isRecording ? <CircleStop size={18} color="#FFFDF7" /> : <Mic size={18} color="#FFFDF7" />}
                </Button>
                <Button circular size="$5" backgroundColor="#E79A5A" onPress={() => askGuide()} disabled={isThinking || isTranscribing} aria-label="Ask Tavi">
                  <Send size={18} color="#FFFDF7" />
                </Button>
              </XStack>
              {tutorError && <SizableText color="#B45C4A">{tutorError}</SizableText>}
            </YStack>
          </Card>

          <Card backgroundColor="#24362B" borderColor="#C97935" borderWidth={1} borderRadius="$6" padding="$4" gap="$4">
            <XStack alignItems="center" justifyContent="space-between" gap="$3">
              <YStack flex={1} gap="$1">
                <SizableText size="$2" color="#F4C66A" fontWeight="900">PREMIUM · 500 COINS</SizableText>
                <H2 color="#FFFDF7" fontSize={25}>Tavi Story Studio</H2>
                <Paragraph color="#E2EFE0" size="$3">Create a connected 48-second lesson with Tavi speaking EBEMBE and a little Swahili.</Paragraph>
              </YStack>
              <YStack backgroundColor="#E79A5A" borderRadius="$10" padding="$3"><Play size={22} color="#FFFDF7" /></YStack>
            </XStack>
            <YStack backgroundColor="#315C45" borderRadius="$4" padding="$3" gap="$2">
              <SizableText color="#FFFDF7" fontWeight="800">Give Tavi a creative brief</SizableText>
              <Input height={82} multiline value={studioPrompt} onChangeText={setStudioPrompt} placeholder="Write what you want Tavi to teach, show, or explain…" placeholderTextColor="#BFD3C1" backgroundColor="#FFFDF7" borderColor="#F4C66A" borderRadius="$3" color="#24362B" />
              <XStack gap="$2" flexWrap="wrap">
                <Button height={46} backgroundColor="#F4C66A" borderRadius="$3" onPress={() => void pickStudioAttachment()} disabled={studioBusy}>
                  <SizableText color="#24362B" fontWeight="900">Upload photo / video</SizableText>
                </Button>
                {studioAttachment && <YStack justifyContent="center" flex={1} minWidth={130}><SizableText size="$2" color="#FFFDF7" numberOfLines={1}>{studioAttachment.name}</SizableText><SizableText size="$1" color="#C9E3C5">Reference ready</SizableText></YStack>}
              </XStack>
              <SizableText size="$2" color="#C9E3C5">You can also talk to Tavi with the microphone in the language guide above. Tavi will recognize your request and use it as the lesson direction.</SizableText>
            </YStack>
            {!studioUnlocked ? (
              <Button height={50} backgroundColor="#E79A5A" borderRadius="$4" onPress={() => void unlockStudio()} disabled={studioBusy || coinMarketLoading || !isSignedIn}>
                <LockKeyhole size={18} color="#FFFDF7" /><SizableText color="#FFFDF7" fontWeight="900">{isSignedIn ? 'Unlock with 500 coins' : 'Sign in to unlock Story Studio'}</SizableText>
              </Button>
            ) : (
              <Button height={50} backgroundColor="#F4C66A" borderRadius="$4" onPress={() => void createStudioStory()} disabled={studioBusy}>
                <Play size={18} color="#24362B" /><SizableText color="#24362B" fontWeight="900">{studioBusy ? `Creating Tavi scenes… ${studioProgress}%` : 'Create 45–60 second story'}</SizableText>
              </Button>
            )}
            {studioBusy && <Progress value={studioProgress} backgroundColor="#50755D" height={8} borderRadius="$10"><Progress.Indicator backgroundColor="#F4C66A" animation="bouncy" /></Progress>}
            {studioAnalysis && <YStack backgroundColor="#FFFDF7" borderRadius="$3" padding="$3"><SizableText size="$2" color="#573E2A" fontWeight="800">TAVI RECOGNIZED</SizableText><SizableText size="$2" color="#573E2A">{studioAnalysis}</SizableText></YStack>}
            {studioNotice && <SizableText size="$2" color="#F4C66A">{studioNotice}</SizableText>}
            {studioError && <SizableText size="$2" color="#F7B8A8">{studioError}</SizableText>}
            {studioVideos.length > 0 && <YStack gap="$4"><SizableText color="#FFFDF7" fontWeight="900">YOUR TAVI STORY · {studioVideos.length * 12} SECONDS</SizableText>{studioVideos.map((url, index) => <StudioVideoPreview key={url} url={url} index={index} onDownload={(videoUrl, sceneIndex) => void downloadStudioVideo(videoUrl, sceneIndex)} />)}</YStack>}
          </Card>

          {!authLoading && !isSignedIn && (
            <Card backgroundColor="#FFFDF7" borderColor="#D8C7B0" borderWidth={1} borderRadius="$5" padding="$4" gap="$3">
              <YStack gap="$1">
                <H3 color="#24362B">Keep learning with Tavi</H3>
                <Paragraph color="#667066">You get two free AI answers. Continue with Google to unlock your account, wallet, and coin-powered conversations.</Paragraph>
              </YStack>
              <Button height={52} backgroundColor="#FFFDF7" borderColor="#315C45" borderWidth={2} borderRadius="$4" onPress={() => void signInWithGoogle()} disabled={authBusy}>
                <SizableText color="#24362B" fontWeight="900">{authBusy ? 'Opening Google…' : 'Continue with Google'}</SizableText>
              </Button>
              {authError && <SizableText color="#B45C4A">{authError}</SizableText>}
            </Card>
          )}
          {isSignedIn && !authLoading && isAdmin && (
            <Card backgroundColor="#F2EBDD" borderColor="#C97935" borderWidth={1} borderRadius="$5" padding="$4" gap="$3">
              <YStack gap="$1">
                <SizableText size="$2" color="#8A542B" fontWeight="800">PRIVATE ADMIN LANGUAGE LAB</SizableText>
                <H3 color="#24362B">Teach and verify Tavi</H3>
                <Paragraph color="#667066">Tavi can ask about the world or propose village-language phrases. You decide whether each phrase is correct, proper, and ready for learners.</Paragraph>
              </YStack>
              <XStack gap="$2" flexWrap="wrap">
                <Input flex={1} minWidth={140} height={44} value={adminEntryForm.phrase} onChangeText={(value) => setAdminEntryForm((form) => ({ ...form, phrase: capitalizeTypedText(value) }))} autoCapitalize="sentences" placeholder="EBEMBE phrase" backgroundColor="#FFFDF7" borderColor="#D8C7B0" borderRadius="$4" color="#24362B" />
                <Input flex={1} minWidth={140} height={44} value={adminEntryForm.meaning} onChangeText={(value) => setAdminEntryForm((form) => ({ ...form, meaning: capitalizeTypedText(value) }))} autoCapitalize="sentences" placeholder="Meaning or question" backgroundColor="#FFFDF7" borderColor="#D8C7B0" borderRadius="$4" color="#24362B" />
                <Input flex={1} minWidth={140} height={44} value={adminEntryForm.pronunciation} onChangeText={(value) => setAdminEntryForm((form) => ({ ...form, pronunciation: value }))} placeholder="Pronunciation" backgroundColor="#FFFDF7" borderColor="#D8C7B0" borderRadius="$4" color="#24362B" />
              </XStack>
              <Input height={54} multiline value={adminEntryForm.answerVariations} onChangeText={(value) => setAdminEntryForm((form) => ({ ...form, answerVariations: capitalizeTypedText(value) }))} autoCapitalize="sentences" placeholder="Answer options — e.g. I'm good | Good | I'm fine | Fine" backgroundColor="#FFFDF7" borderColor="#D8C7B0" borderRadius="$4" color="#24362B" />
              <SizableText size="$1" color="#8A542B">Teach Tavi several approved answers by separating them with |, semicolons, or new lines.</SizableText>
              <Input height={44} value={adminEntryForm.context} onChangeText={(value) => setAdminEntryForm((form) => ({ ...form, context: value }))} placeholder="Usage or cultural context" backgroundColor="#FFFDF7" borderColor="#D8C7B0" borderRadius="$4" color="#24362B" />
              <Button height={46} backgroundColor="#315C45" borderRadius="$4" onPress={async () => {
                if (!adminEntryForm.phrase.trim() || !adminEntryForm.meaning.trim()) return setAdminNotice('Add a phrase and meaning before saving.');
                try {
                  const created = await knowledgeTable.create({ id: `knowledge_${Date.now()}`, userId: ADMIN_USER_ID, language: 'EBEMBE', phrase: capitalizeTypedText(adminEntryForm.phrase.trim()), meaning: capitalizeTypedText(adminEntryForm.meaning.trim()), pronunciation: adminEntryForm.pronunciation.trim() || null, context: adminEntryForm.context.trim() || null, answerVariations: adminEntryForm.answerVariations.trim() || null, status: 'pending', reviewerNote: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
                  const refreshedEntries = await readCurrentKnowledge();
                  setAdminEntries(refreshedEntries);
                  setAdminEntryForm({ phrase: '', meaning: '', pronunciation: '', context: '', answerVariations: '' });
                  setAdminNotice('Saved for review. Confirm it below before Tavi teaches it.');
                  void broadcastKnowledgeChange('created', created.id);
                } catch (error) { setAdminNotice(readableError(error)); }
              }}><SizableText color="#FFFDF7" fontWeight="800">Add phrase for review</SizableText></Button>
              <YStack gap="$2">
                <XStack alignItems="center" justifyContent="space-between">
                  <SizableText size="$2" color="#8A542B" fontWeight="900">REVIEW QUEUE · {pendingAdminEntries.length}</SizableText>
                  <SizableText size="$1" color="#8A542B">Confirm or decline to move it out of this list</SizableText>
                </XStack>
                {reviewEntries.map((entry) => editingEntryId === entry.id ? (
                  <YStack key={entry.id} gap="$2" backgroundColor="#FFFDF7" borderRadius="$4" padding="$3">
                    <SizableText size="$2" color="#8A542B" fontWeight="800">EDIT WORD OR PHRASE</SizableText>
                    <XStack gap="$2" flexWrap="wrap">
                      <Input flex={1} minWidth={130} height={42} value={adminEditForm.phrase} onChangeText={(value) => setAdminEditForm((form) => ({ ...form, phrase: capitalizeTypedText(value) }))} autoCapitalize="sentences" placeholder="EBEMBE phrase" backgroundColor="#F7F4EC" borderColor="#D8C7B0" borderRadius="$3" color="#24362B" />
                      <Input flex={1} minWidth={130} height={42} value={adminEditForm.meaning} onChangeText={(value) => setAdminEditForm((form) => ({ ...form, meaning: capitalizeTypedText(value) }))} autoCapitalize="sentences" placeholder="Meaning" backgroundColor="#F7F4EC" borderColor="#D8C7B0" borderRadius="$3" color="#24362B" />
                    </XStack>
                    <XStack gap="$2" flexWrap="wrap">
                      <Input flex={1} minWidth={130} height={42} value={adminEditForm.pronunciation} onChangeText={(value) => setAdminEditForm((form) => ({ ...form, pronunciation: value }))} placeholder="Pronunciation" backgroundColor="#F7F4EC" borderColor="#D8C7B0" borderRadius="$3" color="#24362B" />
                      <Input flex={1} minWidth={130} height={42} value={adminEditForm.context} onChangeText={(value) => setAdminEditForm((form) => ({ ...form, context: value }))} placeholder="Context" backgroundColor="#F7F4EC" borderColor="#D8C7B0" borderRadius="$3" color="#24362B" />
                    </XStack>
                    <Input height={54} multiline value={adminEditForm.answerVariations} onChangeText={(value) => setAdminEditForm((form) => ({ ...form, answerVariations: capitalizeTypedText(value) }))} autoCapitalize="sentences" placeholder="Approved answers — I'm good | Good | I'm fine | Fine" backgroundColor="#F7F4EC" borderColor="#D8C7B0" borderRadius="$3" color="#24362B" />
                    <SizableText size="$1" color="#8A542B">Separate accepted ways to answer with |, semicolons, or new lines.</SizableText>
                    <XStack gap="$2">
                      <Button flex={1} height={42} backgroundColor="#5F936A" borderRadius="$3" onPress={() => void approveEditedKnowledgeEntry(entry)} disabled={adminActionId === entry.id}><Check size={15} color="#FFFDF7" /><SizableText color="#FFFDF7" fontWeight="800">Approve & save</SizableText></Button>
                      <Button height={42} backgroundColor="#315C45" borderRadius="$3" onPress={() => void saveKnowledgeEntry(entry)} disabled={adminActionId === entry.id}><SizableText color="#FFFDF7" fontWeight="800">Save for review</SizableText></Button>
                      <Button height={42} backgroundColor="#E8E0D2" borderRadius="$3" onPress={() => setEditingEntryId(null)}><X size={15} color="#573E2A" /><SizableText color="#573E2A" fontWeight="800">Cancel</SizableText></Button>
                    </XStack>
                  </YStack>
                ) : (
                  <XStack key={entry.id} alignItems="center" justifyContent="space-between" gap="$2" backgroundColor="#FFFDF7" borderRadius="$4" padding="$3">
                    <YStack flex={1} gap="$1"><SizableText color="#315C45" fontWeight="800">{entry.phrase}</SizableText><SizableText size="$2" color="#573E2A">{entry.meaning}{entry.pronunciation ? ` · ${entry.pronunciation}` : ''}</SizableText>{answerVariations(entry.answerVariations).length > 0 && <SizableText size="$2" color="#8A542B">Answers: {answerVariations(entry.answerVariations).join(' / ')}</SizableText>}<SizableText size="$1" color="#8A542B">PENDING — not used as truth</SizableText></YStack>
                    <XStack gap="$1" flexWrap="wrap" justifyContent="flex-end">
                      <Button height={38} paddingHorizontal="$2" backgroundColor={adminSpeakingId === entry.id ? '#5F936A' : '#E79A5A'} borderRadius="$3" onPress={() => void hearKnowledgeEntry(entry)} disabled={adminSpeakingId === entry.id} aria-label={`Hear ${entry.phrase}`}><Volume2 size={15} color="#FFFDF7" /></Button>
                      <Button height={38} paddingHorizontal="$2" backgroundColor="#D8C7B0" borderRadius="$3" onPress={() => beginEditKnowledgeEntry(entry)} aria-label={`Edit ${entry.phrase}`}><Pencil size={15} color="#573E2A" /></Button>
                      <Button height={38} paddingHorizontal="$2" backgroundColor="#5F936A" borderRadius="$3" onPress={() => void confirmKnowledgeEntry(entry, 'verified')} disabled={adminActionId === entry.id} aria-label={`Confirm ${entry.phrase}`}><SizableText color="#FFFDF7" fontWeight="800">Confirm</SizableText></Button>
                      <Button height={38} paddingHorizontal="$2" backgroundColor="#B45C4A" borderRadius="$3" onPress={() => void confirmKnowledgeEntry(entry, 'rejected')} disabled={adminActionId === entry.id} aria-label={`Reject ${entry.phrase}`}><SizableText color="#FFFDF7" fontWeight="800">Decline</SizableText></Button>
                    </XStack>
                  </XStack>
                ))}
                {pendingAdminEntries.length === 0 && <SizableText size="$2" color="#8A542B">No words are waiting for review.</SizableText>}
              </YStack>
              <YStack gap="$2" backgroundColor="#E8F1E4" borderRadius="$4" padding="$3">
                <XStack alignItems="center" justifyContent="space-between">
                  <SizableText size="$2" color="#315C45" fontWeight="900">AI MEMORY · {memoryEntries.length}</SizableText>
                  <SizableText size="$1" color="#46744F">Tavi can use these words</SizableText>
                </XStack>
                {memoryEntries.filter((entry) => entry.id !== editingEntryId).map((entry) => (
                  <XStack key={`memory-${entry.id}`} alignItems="center" justifyContent="space-between" gap="$2" backgroundColor="#FFFDF7" borderRadius="$3" padding="$3">
                    <YStack flex={1} gap="$1"><SizableText color="#315C45" fontWeight="800">{entry.phrase}</SizableText><SizableText size="$2" color="#573E2A">{entry.meaning}{entry.pronunciation ? ` · ${entry.pronunciation}` : ''}</SizableText>{answerVariations(entry.answerVariations).length > 0 && <SizableText size="$2" color="#46744F">Answers: {answerVariations(entry.answerVariations).join(' / ')}</SizableText>}<SizableText size="$1" color="#46744F">VERIFIED — included in every AI prompt</SizableText></YStack>
                    <XStack gap="$1">
                      <Button height={38} paddingHorizontal="$2" backgroundColor={adminSpeakingId === entry.id ? '#5F936A' : '#E79A5A'} borderRadius="$3" onPress={() => void hearKnowledgeEntry(entry)} disabled={adminSpeakingId === entry.id} aria-label={`Hear memory ${entry.phrase}`}><Volume2 size={15} color="#FFFDF7" /></Button>
                      <Button height={38} paddingHorizontal="$2" backgroundColor="#D8C7B0" borderRadius="$3" onPress={() => beginEditKnowledgeEntry(entry)} aria-label={`Edit memory ${entry.phrase}`}><Pencil size={15} color="#573E2A" /></Button>
                    </XStack>
                  </XStack>
                ))}
                {memoryEntries.length === 0 && <SizableText size="$2" color="#46744F">Confirmed words will appear here and stay available to Tavi.</SizableText>}
              </YStack>
              <YStack gap="$2" backgroundColor="#F7E5E0" borderRadius="$4" padding="$3">
                <XStack alignItems="center" justifyContent="space-between">
                  <SizableText size="$2" color="#8B3F35" fontWeight="900">TRASH · {trashEntries.length}</SizableText>
                  <SizableText size="$1" color="#8B3F35">Never used by Tavi</SizableText>
                </XStack>
                {trashEntries.map((entry) => (
                  <XStack key={`trash-${entry.id}`} alignItems="center" justifyContent="space-between" gap="$2" backgroundColor="#FFFDF7" borderRadius="$3" padding="$3">
                    <YStack flex={1} gap="$1"><SizableText color="#8B3F35" fontWeight="800">{entry.phrase}</SizableText><SizableText size="$2" color="#573E2A">{entry.meaning}</SizableText>{answerVariations(entry.answerVariations).length > 0 && <SizableText size="$2" color="#8B3F35">Answers: {answerVariations(entry.answerVariations).join(' / ')}</SizableText>}<SizableText size="$1" color="#8B3F35">DECLINED — excluded from AI memory</SizableText></YStack>
                    <Button height={38} paddingHorizontal="$2" backgroundColor="#D8C7B0" borderRadius="$3" onPress={() => beginEditKnowledgeEntry(entry)} aria-label={`Edit trash ${entry.phrase}`}><Pencil size={15} color="#573E2A" /></Button>
                  </XStack>
                ))}
                {trashEntries.length === 0 && <SizableText size="$2" color="#8B3F35">Declined words will stay here as protected trash.</SizableText>}
              </YStack>
              <YStack gap="$2" backgroundColor="#FFFDF7" borderRadius="$4" padding="$3">
                <SizableText size="$2" color="#8A542B" fontWeight="800">TAVI ↔ ADMIN CONVERSATION</SizableText>
                {adminMessages.slice(-4).map((message, index) => <SizableText key={`${message.role}-${index}`} color={message.role === 'user' ? '#315C45' : '#573E2A'}>{message.role === 'user' ? 'You: ' : 'Tavi: '}{message.content}</SizableText>)}
                {adminBusy && <XStack alignItems="center" gap="$2" backgroundColor="#FFF1D1" borderRadius="$3" paddingHorizontal="$2" paddingVertical="$1"><YStack width={7} height={7} borderRadius="$10" backgroundColor="#E79A5A" /><SizableText size="$2" color="#8A542B" fontWeight="700">Tavi is writing a response…</SizableText><Button circular size="$4" backgroundColor="#E79A5A" onPress={() => void playAvatar('Tavi is writing a response for the administrator.')} aria-label="Hear Tavi writing status" accessibilityLabel="Hear Tavi writing status"><Volume2 size={15} color="#FFFDF7" /></Button></XStack>}
                <XStack alignItems="center" gap="$2">
                  <Input flex={1} height={44} value={adminQuestion} onChangeText={(value) => { const next = capitalizeTypedText(value); setAdminQuestion(next); setAdminTyping(next.trim().length > 0); }} autoCapitalize="sentences" onSubmitEditing={() => undefined} placeholder="Ask Tavi to explain or propose a phrase" backgroundColor="#F7F4EC" borderColor={adminTyping ? '#E79A5A' : '#D8C7B0'} borderWidth={adminTyping ? 2 : 1} borderRadius="$4" color="#24362B" />
                  {adminTyping && <Button circular size="$5" backgroundColor="#E79A5A" onPress={() => void playAvatar('The administrator is writing a new language question.')} aria-label="Hear writing status" accessibilityLabel="Hear writing status"><Volume2 size={17} color="#FFFDF7" /></Button>}
                  <Button height={44} backgroundColor="#E79A5A" borderRadius="$4" disabled={adminBusy} onPress={async () => { const text = capitalizeTypedText(adminQuestion.trim()); if (!text || adminBusy) return; setAdminQuestion(''); setAdminTyping(false); setAdminBusy(true); try { await adminMessagesTable.create({ id: `admin_${Date.now()}`, userId: ADMIN_USER_ID, role: 'admin', content: text }); const currentKnowledge = await readCurrentKnowledge(); setAdminEntries(currentKnowledge); const response = await blink.ai.generateText({ messages: [{ role: 'system', content: adminTutorPrompt(currentKnowledge) }, ...adminMessages.slice(-8).map((message) => ({ role: message.role, content: message.content })), { role: 'user', content: text }] }); await adminMessagesTable.create({ id: `tavi_${Date.now()}`, userId: ADMIN_USER_ID, role: 'tavi', content: response.text }); setAdminMessages((current) => [...current, { role: 'user', content: text }, { role: 'assistant', content: response.text }]); await playAvatar(response.text); } catch (error) { setAdminNotice(readableError(error)); } finally { setAdminBusy(false); } }}><Send size={16} color="#FFFDF7" /></Button>
                </XStack>
              </YStack>
              {adminNotice && <SizableText size="$2" color="#8A542B">{adminNotice}</SizableText>}
            </Card>
          )}
          {isSignedIn && !authLoading && (
            <Card backgroundColor="#FFF1D1" borderColor="#F4C66A" borderWidth={1} borderRadius="$5" padding="$4" gap="$3">
              <XStack alignItems="center" justifyContent="space-between">
                <YStack gap="$1"><SizableText size="$2" color="#8A542B" fontWeight="800">WALLET</SizableText><H3 color="#573E2A">Keep your Tavi balance ready</H3></YStack>
                <SizableText size="$6" color="#C97935" fontWeight="900">{coinBalanceLoading ? '…' : coinBalance.toLocaleString()}</SizableText>
              </XStack>
              <Button height={44} backgroundColor="#315C45" borderRadius="$4" onPress={() => setWalletOpen((open) => !open)}>
                <SizableText color="#FFFDF7" fontWeight="900">{walletOpen ? 'Hide coin packs' : 'Open wallet · Buy coins'}</SizableText>
              </Button>
              <Paragraph color="#765F4B">After your two free answers, each AI answer costs 1 coin. Buy coins securely with real money through the App Store or Google Play.</Paragraph>
              {walletOpen && (
                <YStack gap="$3">
                  {coinBalanceError && <SizableText size="$2" color="#B45C4A">{coinBalanceError}</SizableText>}
                  <XStack gap="$2" flexWrap="wrap">
                    {(coinPackages.length ? coinPackages : [null, null, null]).map((coinPackage, index) => (
                      <Button key={coinPackage?.identifier ?? `coin-placeholder-${index}`} flex={1} minWidth={92} height={58} backgroundColor="#E79A5A" borderRadius="$4" onPress={() => void buyCoinPackage(index)} disabled={!coinPackage || coinMarketLoading}>
                        <YStack alignItems="center" gap="$1"><SizableText size="$2" color="#FFFDF7" fontWeight="800">{COIN_PACKS[index].coins.toLocaleString()}</SizableText><SizableText size="$1" color="#FFFDF7">{coinPackage?.product.priceString ?? (coinMarketLoading ? 'Loading…' : 'Unavailable')}</SizableText></YStack>
                      </Button>
                    ))}
                  </XStack>
                  <XStack alignItems="center" justifyContent="space-between">
                    <Button chromeless onPress={() => void restoreCoins()}><SizableText size="$2" color="#8A542B" fontWeight="700">Restore purchases</SizableText></Button>
                    <Button chromeless onPress={() => void refreshCoinMarket()}><SizableText size="$2" color="#8A542B" fontWeight="700">Refresh packs</SizableText></Button>
                  </XStack>
                  {coinMarketError && <SizableText size="$2" color="#8A542B">{coinMarketError}</SizableText>}
                  {coinNotice && <SizableText size="$2" color="#8A542B">{coinNotice}</SizableText>}
                </YStack>
              )}
            </Card>
          )}
          {isSignedIn && !authLoading && (
            <XStack justifyContent="flex-end" gap="$3">
              <Button chromeless onPress={() => void switchAccount()} disabled={authBusy}><SizableText color="#8A542B" fontWeight="700">Switch account</SizableText></Button>
              <Button chromeless onPress={() => void blink.auth.signOut()} disabled={authBusy}><SizableText color="#B45C4A" fontWeight="700">Log out</SizableText></Button>
            </XStack>
          )}

          <Card backgroundColor="#315C45" borderRadius="$6" padding="$5" borderWidth={0}>
            <XStack justifyContent="space-between" alignItems="flex-start">
              <YStack gap="$2" flex={1}>
                <SizableText color="#C9E3C5" size="$3" fontWeight="800">TODAY'S LESSON</SizableText>
                <H2 color="#FFFDF7" fontSize={26}>Warm greetings</H2>
                <Paragraph color="#E2EFE0" size="$4">Learn 5 ways to welcome someone home.</Paragraph>
              </YStack>
              <YStack backgroundColor="#E79A5A" borderRadius="$10" padding="$3"><Headphones size={23} color="#FFFDF7" /></YStack>
            </XStack>
            <XStack alignItems="center" gap="$3" marginTop="$5">
              <Progress value={completed ? 100 : 20} backgroundColor="#50755D" flex={1} height={8} borderRadius="$10"><Progress.Indicator backgroundColor="#E79A5A" animation="bouncy" /></Progress>
              <SizableText color="#FFFDF7" fontWeight="800">{completed ? '5/5' : '1/5'}</SizableText>
            </XStack>
            <Button marginTop="$4" backgroundColor="#F4C66A" color="#24362B" borderRadius="$4" height={50} onPress={() => { impact(); setCompleted((value) => !value); }}>
              <SizableText fontWeight="800" color="#24362B">{completed ? 'Practice again' : 'Complete lesson'}</SizableText><ArrowRight size={18} color="#24362B" />
            </Button>
          </Card>

          <XStack gap="$3">
            <Card flex={1} backgroundColor="#FFFDF7" borderColor="#E7E1D3" borderWidth={1} borderRadius="$5" padding="$4">
              <XStack justifyContent="space-between"><SizableText size="$3" color="#7B8177">MASTERED</SizableText><Check size={18} color="#5F936A" /></XStack><H2 marginTop="$2" color="#24362B">24</H2><SizableText color="#7B8177">words this week</SizableText>
            </Card>
            <Card flex={1} backgroundColor="#FFFDF7" borderColor="#E7E1D3" borderWidth={1} borderRadius="$5" padding="$4">
              <XStack justifyContent="space-between"><SizableText size="$3" color="#7B8177">GOAL</SizableText><Leaf size={18} color="#C97935" /></XStack><H2 marginTop="$2" color="#24362B">5 min</H2><SizableText color="#7B8177">of 10 today</SizableText>
            </Card>
          </XStack>

          <YStack gap="$3">
            <XStack alignItems="center" justifyContent="space-between"><H3 color="#24362B">Hear it in context</H3><SizableText color="#C97935" fontWeight="700">Pronunciation guide</SizableText></XStack>
            <Card backgroundColor="#FFFDF7" borderColor="#E7E1D3" borderWidth={1} borderRadius="$5" padding="$4" gap="$4">
              {words.map((word) => (
                <XStack key={word.native} alignItems="center" justifyContent="space-between">
                  <XStack alignItems="center" gap="$3"><YStack backgroundColor="#E8F1E4" borderRadius="$4" padding="$3"><SizableText size="$5" fontWeight="800" color="#315C45">{word.native}</SizableText></YStack><YStack><SizableText fontWeight="700" color="#24362B">{word.meaning}</SizableText><SizableText size="$2" color="#899087">{word.sound}</SizableText></YStack></XStack>
                  <Button circular size="$4" chromeless backgroundColor={heard === word.native ? '#E79A5A' : '#F2EBDD'} onPress={() => { impact(); setHeard(word.native); void playAvatar(`${word.native}. ${word.meaning}. Pronunciation: ${word.sound}.`); }} aria-label={`Hear ${word.native}`} accessibilityLabel={`Hear ${word.native}`} accessibilityRole="button"><Volume2 size={19} color={heard === word.native ? '#FFFDF7' : '#315C45'} /></Button>
                </XStack>
              ))}
              {heard && <SizableText color="#5F936A">Playing native pronunciation for {heard}.</SizableText>}
            </Card>
          </YStack>

          <YStack backgroundColor="#F1E7D6" borderRadius="$5" padding="$4" gap="$3">
            <XStack alignItems="center" gap="$3"><Mic size={21} color="#8A542B" /><H3 color="#573E2A">Try a quick check</H3></XStack><Paragraph color="#765F4B">Which word means “Thank you”?</Paragraph>
            <XStack gap="$2" flexWrap="wrap">{['Mōra', 'Ayo', 'Nami'].map((answer) => <Button key={answer} minWidth={88} height={46} borderRadius="$4" backgroundColor={selected === answer ? (answer === 'Ayo' ? '#5F936A' : '#D9836A') : '#FFFDF7'} onPress={() => chooseAnswer(answer)}><SizableText color={selected === answer ? '#FFFDF7' : '#315C45'} fontWeight="700">{answer}</SizableText></Button>)}</XStack>
            {selected && <SizableText color={selected === 'Ayo' ? '#46744F' : '#B45C4A'} fontWeight="700">{selected === 'Ayo' ? 'Correct — you heard that beautifully.' : 'Almost. Listen once more and try again.'}</SizableText>}
          </YStack>

          <XStack alignItems="center" gap="$2" justifyContent="center" paddingTop="$2"><LockKeyhole size={14} color="#8B9187" /><SizableText size="$2" color="#8B9187">Your community’s words stay protected.</SizableText></XStack>
        </YStack>
      </ScrollView>
    </YStack>
  );
}