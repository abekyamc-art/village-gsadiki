// Auto-generated from your database schema — do not edit by hand.
// Regenerates automatically whenever a table is created or altered.

export type UsersRow = {
  id: string
  email: string
  emailVerified: number | string | null
  displayName: string | null
  avatarUrl: string | null
  phone: string | null
  phoneVerified: number | string | null
  role: string | null
  metadata: string | null
  createdAt: string
  updatedAt: string
  lastSignIn: string
}

export type VillageVoiceAdminMessagesRow = {
  id: string
  userId: string
  role: string
  content: string
  createdAt: string
}

export type VillageVoiceCoinBalancesRow = {
  id: string
  userId: string
  coins: number | string
  updatedAt: string
}

export type VillageVoiceCoinTransactionsRow = {
  id: string
  userId: string
  productId: string
  coins: number | string
  revenuecatEventId: string | null
  createdAt: string
}

export type VillageVoiceKnowledgeRow = {
  id: string
  userId: string
  language: string
  phrase: string
  meaning: string
  pronunciation: string | null
  context: string | null
  status: string
  reviewerNote: string | null
  createdAt: string
  updatedAt: string
  answerVariations: string | null
}
