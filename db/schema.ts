import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// A single row coordinates admissions and the active provider call across every visitor.
export const demoAiControl = sqliteTable('demo_ai_control', {
  id: integer('id').primaryKey(),
  quotaDay: text('quota_day').notNull().default(''),
  admissions: integer('admissions').notNull().default(0),
  tokenHash: text('token_hash'),
  state: text('state').notNull().default('idle'),
  callId: text('call_id'),
  expiresAt: integer('expires_at').notNull().default(0),
  closeRequested: integer('close_requested').notNull().default(0),
  createdAt: integer('created_at').notNull().default(0),
});
