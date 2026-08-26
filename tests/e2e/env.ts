/** Local-only credentials matching `.dev.vars.example` and schema token hashes. */

export const LOCAL = {
  supabaseUrl: process.env.SUPABASE_URL?.replace(/\/$/, '') || 'http://127.0.0.1:54321',
  databaseUrl:
    process.env.QUANTANAMO_DATABASE_URL
    || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  /** Default Supabase local anon JWT. */
  anonKey:
    process.env.SUPABASE_PUBLISHABLE_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  /** Default Supabase local service_role JWT. */
  serviceRoleKey:
    process.env.SUPABASE_SECRET_KEY
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  dashboardToken: 'local-dashboard-token-do-not-use-in-prod',
  managerToken: 'local-manager-token-do-not-use-in-prod',
  publicationToken: 'local-publication-token-do-not-use-in-prod',
  internalToken: 'local-internal-token-do-not-use-in-prod',
  managerUserId: 'local@quantanamo.dev',
} as const;
