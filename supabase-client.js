// Config do Supabase — a anon key é pública por natureza (RLS quem protege os dados, ver schema.sql).
// Preencha com os valores do seu projeto: Supabase > Project Settings > API.
const SUPABASE_URL = 'https://dihgzruiasifkwjpewtq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpaGd6cnVpYXNpZmt3anBld3RxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3Mjg5MTksImV4cCI6MjA5MDMwNDkxOX0.lJkdbqcH3HOFeqUdQ2FotFdplCYkIaRtr8Y0ibY6wv4';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
