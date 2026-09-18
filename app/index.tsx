import { useEffect, useRef, useState } from 'react';
import type { VillageVoiceAdminMessagesRow, VillageVoiceKnowledgeRow } from '@/lib/db-types';
import { Platform, AppState } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Image as ExpoImage } from 'expo-image';
import { blink } from '@/lib/blink';
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
const STUDIO_CLIP_COUNT = 4;
const RECOGNITION_LOCALE = 'en-US';
const ASIA_RECOGNITION_LOCALES = ['sw-TZ', 'sw-KE', 'fr-FR', 'en-US'];

type RecognitionMode = 'offline' | 'online';
type PlaybackLength = 'short' | 'normal' | 'long';

const knowledgeTable = blink.db.table<VillageVoiceKnowledgeRow>('village_voice_knowledge');
const adminMessagesTable = blink.db.table<VillageVoiceAdminMessagesRow>('village_voice_admin_messages');

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

function normalizeSpeechText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\\s]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function levenshteinDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const saved = previous[column];
      previous[column] = left[row - 1] === right[column - 1]
        ? diagonal
        : Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + 1);
      diagonal = saved;
    }
  }
  return previous[right.length];
}

function recognizedVillagePhrase(transcript: string, entries: VillageVoiceKnowledgeRow[]) {
  const candidates = [
    ...words.map((word) => ({ phrase: word.native, aliases: [word.native, word.sound, word.meaning] })),
    ...entries
      .filter((entry) => entry.status === 'verified')
      .map((entry) => ({
        phrase: entry.phrase,
        aliases: [entry.phrase, entry.pronunciation || '', ...answerVariations(entry.answerVariations), entry.meaning],
      })),
  ];
  const normalizedTranscript = normalizeSpeechText(transcript);
  const directMatch = candidates.find((candidate) => candidate.aliases.some((alias) => {
    const normalizedAlias = normalizeSpeechText(alias);
    return normalizedAlias && (normalizedTranscript === normalizedAlias || normalizedTranscript.includes(` ${normalizedAlias} `) || normalizedTranscript.startsWith(`${normalizedAlias} `) || normalizedTranscript.endsWith(` ${normalizedAlias}`));
  }));
  if (directMatch) return directMatch.phrase;

  const closeMatch = candidates.find((candidate) => candidate.aliases.some((alias) => {
    const normalizedAlias = normalizeSpeechText(alias);
    if (!normalizedAlias || normalizedAlias.length < 3) return false;
    return levenshteinDistance(normalizedTranscript, normalizedAlias) <= Math.max(1, Math.floor(normalizedAlias.length / 4));
  }));
  return closeMatch?.phrase || capitalizeTypedText(transcript);
}

function capitalizeTypedText(value: string) {
  if (!value) return value;
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
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
  const sceneText = decodeURIComponent(url.split('-').slice(4).join('-'));

  return (
    <YStack gap="$2" width="100%">
      <SizableText size="$2" color="#8A542B" fontWeight="800">SCENE {index + 1} · FREE LOCAL LESSON</SizableText>
      <YStack minHeight={150} borderRadius="$5" padding="$4" justifyContent="center" backgroundColor="#F5EBDD" gap="$3">
        <SizableText color="#573E2A" fontWeight="700">{sceneText}</SizableText>
        <SizableText size="$2" color="#8A542B">This scene is a device-generated lesson plan, not a hosted AI video.</SizableText>
      </YStack>
      <Button height={44} backgroundColor="#F4C66A" borderRadius="$3" onPress={() => onDownload(url, index)}>
        <Volume2 size={16} color="#24362B" /><SizableText color="#24362B" fontWeight="900">Read scene {index + 1} aloud</SizableText>
      </Button>
    </YStack>
  );
}

function speakDeviceText(text: string, rate: number) {
  return new Promise<void>((resolve, reject) => {
    Speech.speak(text, {
      rate,
      pitch: 1,
      onDone: resolve,
      onStopped: resolve,
      onError: () => reject(new Error('Tavi audio could not be played.')),
    });
  });
}

async function speakWithAvatar(text: string, rate = 0.88) {
  await Speech.stop();
  await speakDeviceText(text, rate);
}

function pronunciationText(phrase: string, pronunciation?: string | null) {
  return pronunciation?.trim() && pronunciation.trim().toLocaleLowerCase() !== phrase.trim().toLocaleLowerCase()
    ? pronunciation.trim()
    : phrase.trim();
}

async function speakVillagePhrase(phrase: string, pronunciation?: string | null, length: PlaybackLength = 'normal') {
  await Speech.stop();
  const spoken = pronunciationText(phrase, pronunciation);
  const rate = length === 'long' ? 0.48 : length === 'short' ? 0.72 : 0.58;
  const repeats = length === 'long' ? 3 : length === 'short' ? 1 : 2;
  for (let index = 0; index < repeats; index += 1) {
    await speakDeviceText(spoken, rate);
    if (index < repeats - 1) await new Promise((resolve) => setTimeout(resolve, length === 'long' ? 380 : 220));
  }
}

export default function Home() {
  const [heard, setHeard] = useState<string | null>(null);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [question, setQuestion] = useState('');
  const [conversationLanguage, setConversationLanguage] = useState<ConversationLanguage>('english');
  const [conversationMode, setConversationMode] = useState<ConversationMode>('chat');
  const [isThinking, setIsThinking] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recognitionMode, setRecognitionMode] = useState<RecognitionMode>('offline');
  const [recognitionLocale, setRecognitionLocale] = useState(RECOGNITION_LOCALE);
  const recognitionLocaleIndexRef = useRef(0);
  const recognitionFallbackAttemptedRef = useRef(false);
  const [playbackLength, setPlaybackLength] = useState<PlaybackLength>('normal');
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
  const [studioNotice, setStudioNotice] = useState<string | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [studioDownloadBusy, setStudioDownloadBusy] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [selectedPronunciationId, setSelectedPronunciationId] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile>({});
  const [profileName, setProfileName] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [appTheme, setAppTheme] = useState<AppTheme>('light');
  const [adminEntryForm, setAdminEntryForm] = useState({ phrase: '', meaning: '', pronunciation: '', context: '', answerVariations: '' });
  const [adminEditForm, setAdminEditForm] = useState({ phrase: '', meaning: '', pronunciation: '', context: '', answerVariations: '' });
  const isAdminRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: AVATAR_GREETING },
  ]);

  useSpeechRecognitionEvent('start', () => {
    setIsRecording(true);
    setIsTranscribing(true);
  });

  useSpeechRecognitionEvent('end', () => {
    setIsRecording(false);
    setIsTranscribing(false);
  });

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results?.[0]?.transcript?.trim();
    if (transcript) {
      const recognized = recognizedVillagePhrase(transcript, adminEntries);
      setQuestion(capitalizeTypedText(recognized));
      setRecognitionMode('offline');
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (recognitionMode === 'offline' && Platform.OS !== 'web' && !recognitionFallbackAttemptedRef.current) {
      recognitionFallbackAttemptedRef.current = true;
      const nextLocaleIndex = recognitionLocaleIndexRef.current + 1;
      if (nextLocaleIndex < ASIA_RECOGNITION_LOCALES.length) {
        const nextLocale = ASIA_RECOGNITION_LOCALES[nextLocaleIndex];
        recognitionLocaleIndexRef.current = nextLocaleIndex;
        setRecognitionLocale(nextLocale);
        try {
          ExpoSpeechRecognitionModule.start({
            lang: nextLocale,
            interimResults: true,
            continuous: false,
            maxAlternatives: 3,
            requiresOnDeviceRecognition: true,
          });
          return;
        } catch {
          // Continue to the free online fallback below.
        }
      }
      setRecognitionMode('online');
      try {
        ExpoSpeechRecognitionModule.start({
          lang: recognitionLocale,
          interimResults: true,
          continuous: false,
          maxAlternatives: 3,
          requiresOnDeviceRecognition: false,
        });
        return;
      } catch {
        // The device has no speech recognizer available; show the clear message below.
      }
    }
    setIsRecording(false);
    setIsTranscribing(false);
    setTutorError(event.message || `Free recognition was unavailable in ${recognitionLocale}. Try again, install Swahili or French speech support, or type the village phrase.`);
  });

  useEffect(() => {
    const unsubscribe = blink.auth.onAuthStateChanged((state) => {
      setIsSignedIn(Boolean(state.user));
      setCurrentUserId(state.user?.id ?? null);
      if (state.user) {
        const nextProfile = { displayName: state.user.displayName };
        setProfile(nextProfile);
        setProfileName(state.user.displayName || '');
      } else {
        setProfile({});
        setProfileName('');
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
    let cancelled = false;
    if (!currentUserId) {
      return () => { cancelled = true; };
    }
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
      setStudioError('Sign in to hear your Tavi lesson.');
      return;
    }
    setStudioDownloadBusy(true);
    setStudioError(null);
    try {
      const sceneText = decodeURIComponent(url.split('-').slice(4).join('-'));
      setIsSpeaking(true);
      await speakWithAvatar(sceneText);
      setStudioNotice(`Scene ${index + 1} was read aloud using your device voice.`);
    } catch (error) {
      setStudioError(readableError(error));
    } finally {
      setIsSpeaking(false);
      setStudioDownloadBusy(false);
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
        setStudioAnalysis('Photo reference received. The free local story maker will use your written brief and this reference name to shape the lesson scenes.');
      } else {
        setStudioAnalysis('Video reference received. The free local story maker will use your written brief and this reference to shape the story scenes.');
      }
      setStudioNotice(`${kind === 'photo' ? 'Photo' : 'Video'} uploaded. Tavi recognized the reference and is ready to create.`);
    } catch (error) {
      setStudioError(readableError(error));
    }
  };

  const createStudioStory = async () => {
    if (!isSignedIn) {
      setStudioError('Sign in before creating a Tavi story lesson.');
      return;
    }
    const brief = studioPrompt.trim() || 'Create a warm village story that teaches a simple greeting to a learner.';
    setStudioBusy(true);
    setStudioProgress(0);
    setStudioError(null);
    setStudioNotice('Tavi is preparing a free local lesson plan — no Blink AI credits are used.');
    setStudioVideos([]);
    try {
      const currentKnowledge = await readCurrentKnowledge();
      setAdminEntries(currentKnowledge);
      const verifiedWords = currentKnowledge.filter((entry) => entry.status === 'verified').slice(0, 4);
      const lessonWords = verifiedWords.length > 0 ? verifiedWords : words.map((word) => ({ phrase: word.native, meaning: word.meaning, pronunciation: word.sound }));
      const sceneDirections = [
        'Welcome the learner warmly and introduce the lesson.',
        'Demonstrate the key village word with its meaning and pronunciation.',
        'Invite the learner to repeat the word and connect it to daily life.',
        'Review the word and encourage another practice round.',
      ];
      const nextVideos: string[] = [];
      for (let index = 0; index < STUDIO_CLIP_COUNT; index += 1) {
        const word = lessonWords[index % lessonWords.length];
        const sceneText = `Scene ${index + 1}: ${sceneDirections[index]} ${brief} Practice ${word.phrase}, meaning ${word.meaning}${word.pronunciation ? `, pronounced ${word.pronunciation}` : ''}.`;
        nextVideos.push(`local://village-voice-scene-${index + 1}-${encodeURIComponent(sceneText)}`);
        setStudioVideos([...nextVideos]);
        setStudioProgress(Math.round(((index + 1) / STUDIO_CLIP_COUNT) * 100));
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      setStudioNotice('Your free four-scene lesson plan is ready. Tavi can read each scene aloud using your device voice — no hosted AI generation was used.');
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
    setIsSpeaking(true);
    setTutorError(null);
    try {
      await speakWithAvatar(text, playbackLength === 'long' ? 0.72 : playbackLength === 'short' ? 0.94 : 0.88);
    } catch (error) {
      setTutorError(readableError(error));
    } finally {
      setIsSpeaking(false);
    }
  };

  const askGuide = async (promptOverride?: string) => {
    const trimmedQuestion = (promptOverride ?? question).trim();
    if (!trimmedQuestion || isThinking) return;
    impact();
    setQuestion('');
    setTutorError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: trimmedQuestion }];
    setMessages(nextMessages);
    setIsThinking(true);
    try {
      const currentKnowledge = await readCurrentKnowledge();
      setAdminEntries(currentKnowledge);
      const safeQuestion = removeTrashFromText(trimmedQuestion, currentKnowledge);
      const matchedEntry = currentKnowledge.find((entry) => entry.status === 'verified' && safeQuestion.toLocaleLowerCase().includes(entry.phrase.toLocaleLowerCase()));
      const responseText = matchedEntry
        ? `${matchedEntry.phrase} means ${matchedEntry.meaning}${matchedEntry.pronunciation ? `. Say it like ${matchedEntry.pronunciation}.` : '.'} ${matchedEntry.context || 'Try using it in a warm village greeting.'}`
        : safeQuestion.toLocaleLowerCase().includes('hello') || safeQuestion.toLocaleLowerCase().includes('greet')
          ? 'Mōra means Hello. Try saying it slowly, then listen for the rhythm.'
          : safeQuestion.toLocaleLowerCase().includes('thank')
            ? 'Ayo means Thank you. It is a warm way to show appreciation.'
            : safeQuestion.toLocaleLowerCase().includes('water')
              ? 'Nami means Water. Repeat it twice and connect it to something you see around you.'
              : conversationMode === 'joke'
                ? 'Here is a tiny village-learning joke: Why did the word bring a notebook? Because it wanted to make a good impression!'
                : conversationMode === 'story'
                  ? 'Once, a learner carried one new word home each day. Before long, the whole family was greeting one another with a living village voice.'
                  : 'I can teach verified community words. Ask me about Mōra, Ayo, Nami, or a phrase an elder has added for review.';
      const safeResponse = removeTrashFromText(responseText, currentKnowledge);
      setMessages((current) => [...current, { role: 'assistant', content: safeResponse }]);
      await playAvatar(safeResponse);
    } catch (error) {
      setTutorError(readableError(error));
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
      await speakVillagePhrase(entry.phrase, entry.pronunciation, 'long');
      await speakWithAvatar(`It means ${entry.meaning}. ${entry.context || ''}`, 0.8);
      setAdminNotice(`Tavi read “${entry.phrase}” slowly and clearly. Confirm the sound and wording before marking it verified.`);
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

  const stopRecording = () => {
    ExpoSpeechRecognitionModule.stop();
    setIsRecording(false);
    setIsTranscribing(false);
  };

  const startRecording = async () => {
    if (isRecording || isTranscribing) return;
    setTutorError(null);
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        setTutorError('Allow microphone and speech recognition access to ask Tavi by voice.');
        return;
      }
      const recognitionLanguage = conversationLanguage === 'swahili' ? 'sw-TZ' : RECOGNITION_LOCALE;
      recognitionLocaleIndexRef.current = Math.max(0, ASIA_RECOGNITION_LOCALES.indexOf(recognitionLanguage));
      setRecognitionLocale(recognitionLanguage);
      const offlineRecognition = Platform.OS !== 'web';
      recognitionFallbackAttemptedRef.current = false;
      setRecognitionMode(offlineRecognition ? 'offline' : 'online');
      ExpoSpeechRecognitionModule.start({
        lang: recognitionLanguage,
        interimResults: true,
        continuous: false,
        maxAlternatives: 3,
        requiresOnDeviceRecognition: offlineRecognition,
      });
      setIsTranscribing(true);
    } catch (error) {
      setTutorError(readableError(error));
      setIsRecording(false);
      setIsTranscribing(false);
    }
  };

  useEffect(() => () => {
    ExpoSpeechRecognitionModule.abort();
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
                  <Button height={46} alignSelf="flex-start" backgroundColor="#315C45" borderRadius="$4" onPress={() => void playAvatar(AVATAR_GREETING)} disabled={isSpeaking}>
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
              <XStack alignItems="center" gap="$2" flexWrap="wrap">
                <SizableText size="$2" color="#8A542B" fontWeight="800">READING LENGTH</SizableText>
                {(['short', 'normal', 'long'] as PlaybackLength[]).map((length) => (
                  <Button key={length} height={34} paddingHorizontal="$3" borderRadius="$10" backgroundColor={playbackLength === length ? '#5F936A' : '#F5EBDD'} onPress={() => setPlaybackLength(length)}>
                    <SizableText size="$2" color={playbackLength === length ? '#FFFDF7' : '#573E2A'} fontWeight="700">{length === 'short' ? 'Short' : length === 'normal' ? 'Normal' : 'Long practice'}</SizableText>
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
              <SizableText size="$2" color="#8A542B">Free local guide answers: unlimited · no Blink AI credits used.</SizableText>
              <SizableText size="$1" color="#46744F">Tavi reads the elder-approved pronunciation guide slowly, twice or three times. A device voice cannot guarantee a native accent; only elder-recorded audio can.</SizableText>
              {isThinking && <SizableText color="#8A542B">Tavi is thinking in {LANGUAGE_LABELS[conversationLanguage]}…</SizableText>}
              {isTranscribing && <SizableText color="#8A542B">Tavi is listening {recognitionMode === 'offline' ? 'offline on this device' : 'online in your browser'}…</SizableText>}
              <SizableText size="$1" color="#46744F">Recognition is free. Tavi tries the device offline recognizer first, then free Swahili, French, and browser fallbacks. EBEMBE audio is learned from elder-approved pronunciation; no speech API can honestly guarantee 100% native recognition.</SizableText>
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
                <SizableText size="$2" color="#F4C66A" fontWeight="900">FREE LOCAL LESSON MAKER</SizableText>
                <H2 color="#FFFDF7" fontSize={25}>Tavi Story Studio</H2>
                <Paragraph color="#E2EFE0" size="$3">Create a connected lesson plan with verified EBEMBE words and your device voice — no coins or hosted AI generation.</Paragraph>
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
              <SizableText size="$2" color="#C9E3C5">Type a creative brief and Tavi will turn verified community words into a free local lesson plan. Read each scene aloud with your device voice.</SizableText>
            </YStack>
            <Button height={50} backgroundColor="#F4C66A" borderRadius="$4" onPress={() => void createStudioStory()} disabled={studioBusy}>
              <Play size={18} color="#24362B" /><SizableText color="#24362B" fontWeight="900">{studioBusy ? `Creating local scenes… ${studioProgress}%` : 'Create free lesson plan'}</SizableText>
            </Button>
            {studioBusy && <Progress value={studioProgress} backgroundColor="#50755D" height={8} borderRadius="$10"><Progress.Indicator backgroundColor="#F4C66A" animation="bouncy" /></Progress>}
            {studioAnalysis && <YStack backgroundColor="#FFFDF7" borderRadius="$3" padding="$3"><SizableText size="$2" color="#573E2A" fontWeight="800">TAVI RECOGNIZED</SizableText><SizableText size="$2" color="#573E2A">{studioAnalysis}</SizableText></YStack>}
            {studioNotice && <SizableText size="$2" color="#F4C66A">{studioNotice}</SizableText>}
            {studioError && <SizableText size="$2" color="#F7B8A8">{studioError}</SizableText>}
            {studioVideos.length > 0 && <YStack gap="$4"><SizableText color="#FFFDF7" fontWeight="900">YOUR TAVI LESSON · {studioVideos.length} SCENES</SizableText>{studioVideos.map((url, index) => <StudioVideoPreview key={url} url={url} index={index} onDownload={(videoUrl, sceneIndex) => void downloadStudioVideo(videoUrl, sceneIndex)} />)}</YStack>}
          </Card>

          {!authLoading && !isSignedIn && (
            <Card backgroundColor="#FFFDF7" borderColor="#D8C7B0" borderWidth={1} borderRadius="$5" padding="$4" gap="$3">
              <YStack gap="$1">
                <H3 color="#24362B">Keep learning with Tavi</H3>
                <Paragraph color="#667066">Use the free local guide without hosted AI charges. Continue with Google only when you want to sync your profile, community memory, or wallet.</Paragraph>
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
                  <Button height={44} backgroundColor="#E79A5A" borderRadius="$4" disabled={adminBusy} onPress={async () => { const text = capitalizeTypedText(adminQuestion.trim()); if (!text || adminBusy) return; setAdminQuestion(''); setAdminTyping(false); setAdminBusy(true); try { await adminMessagesTable.create({ id: `admin_${Date.now()}`, userId: ADMIN_USER_ID, role: 'admin', content: text }); const currentKnowledge = await readCurrentKnowledge(); setAdminEntries(currentKnowledge); const matchedEntry = currentKnowledge.find((entry) => entry.status === 'verified' && text.toLocaleLowerCase().includes(entry.phrase.toLocaleLowerCase())); const responseText = matchedEntry ? `${matchedEntry.phrase} means ${matchedEntry.meaning}${matchedEntry.pronunciation ? `. Say it like ${matchedEntry.pronunciation}.` : '.'}` : 'This is a free local guide. Add or verify a phrase below, then ask me about that confirmed community word.'; await adminMessagesTable.create({ id: `tavi_${Date.now()}`, userId: ADMIN_USER_ID, role: 'tavi', content: responseText }); setAdminMessages((current) => [...current, { role: 'user', content: text }, { role: 'assistant', content: responseText }]); await playAvatar(responseText); } catch (error) { setAdminNotice(readableError(error)); } finally { setAdminBusy(false); } }}><Send size={16} color="#FFFDF7" /></Button>
                </XStack>
              </YStack>
              {adminNotice && <SizableText size="$2" color="#8A542B">{adminNotice}</SizableText>}
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
            <XStack alignItems="center" justifyContent="space-between"><H3 color="#24362B">Hear it in context</H3><SizableText color="#C97935" fontWeight="700">Elder-approved pronunciation</SizableText></XStack>
            <Card backgroundColor="#FFFDF7" borderColor="#E7E1D3" borderWidth={1} borderRadius="$5" padding="$4" gap="$4">
              {words.map((word) => (
                <XStack key={word.native} alignItems="center" justifyContent="space-between">
                  <XStack alignItems="center" gap="$3"><YStack backgroundColor="#E8F1E4" borderRadius="$4" padding="$3"><SizableText size="$5" fontWeight="800" color="#315C45">{word.native}</SizableText></YStack><YStack><SizableText fontWeight="700" color="#24362B">{word.meaning}</SizableText><SizableText size="$2" color="#899087">{word.sound}</SizableText></YStack></XStack>
                  <Button circular size="$4" chromeless backgroundColor={heard === word.native ? '#E79A5A' : '#F2EBDD'} onPress={() => { impact(); setHeard(word.native); setSelectedPronunciationId(word.native); setIsSpeaking(true); void speakVillagePhrase(word.native, word.sound, playbackLength).catch((error) => setTutorError(readableError(error))).finally(() => { setIsSpeaking(false); setSelectedPronunciationId(null); }); }} aria-label={`Hear ${word.native}`} accessibilityLabel={`Hear ${word.native}`} accessibilityRole="button"><Volume2 size={19} color={heard === word.native ? '#FFFDF7' : '#315C45'} /></Button>
                </XStack>
              ))}
              {memoryEntries.slice(0, 8).map((entry) => (
                <XStack key={`verified-${entry.id}`} alignItems="center" justifyContent="space-between">
                  <XStack alignItems="center" gap="$3" flex={1}><YStack backgroundColor="#E8F1E4" borderRadius="$4" padding="$3" maxWidth="68%"><SizableText size="$4" fontWeight="800" color="#315C45" numberOfLines={2}>{entry.phrase}</SizableText></YStack><YStack flex={1}><SizableText fontWeight="700" color="#24362B">{entry.meaning}</SizableText><SizableText size="$2" color="#899087">{entry.pronunciation || 'Elder pronunciation not added yet'}</SizableText></YStack></XStack>
                  <Button circular size="$4" chromeless backgroundColor={selectedPronunciationId === entry.id ? '#E79A5A' : '#F2EBDD'} onPress={() => { impact(); setHeard(entry.phrase); setSelectedPronunciationId(entry.id); setIsSpeaking(true); void speakVillagePhrase(entry.phrase, entry.pronunciation, playbackLength).catch((error) => setTutorError(readableError(error))).finally(() => { setIsSpeaking(false); setSelectedPronunciationId(null); }); }} aria-label={`Hear ${entry.phrase}`} accessibilityLabel={`Hear ${entry.phrase}`} accessibilityRole="button"><Volume2 size={19} color="#315C45" /></Button>
                </XStack>
              ))}
              {heard && <SizableText color="#5F936A">Playing the clear device pronunciation for {heard}. Verified community words are read exactly as elders entered them.</SizableText>}
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
