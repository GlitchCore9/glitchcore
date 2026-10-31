import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
});
const defaultKey = (pluralName: string, legacyName: string) => {
  try {
    const keys = JSON.parse(Deno.env.get(pluralName) || '{}');
    if (keys.default) return keys.default as string;
  } catch { /* Fall back to the legacy environment variable. */ }
  return Deno.env.get(legacyName);
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = defaultKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const serviceKey = defaultKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ error: 'Server is not configured' }, 500);

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401);
  const authClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const { data: { user: actor }, error: authError } = await authClient.auth.getUser();
  if (authError || !actor) return json({ error: 'Invalid session' }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: role, error: roleError } = await admin.from('platform_admins').select('user_id').eq('user_id', actor.id).maybeSingle();
  if (roleError) return json({ error: 'Unable to verify administrator role' }, 500);
  let input: { action?: string; user_id?: string; reason?: string };
  try { input = await request.json(); } catch { return json({ error: 'Invalid request body' }, 400); }
  const action = input.action;
  if (action === 'is_admin') return json({ is_admin: Boolean(role) });
  if (!role) return json({ error: 'Platform administrator access required' }, 403);
  const userId = input.user_id;
  if (!['list', 'block', 'unblock', 'preview_delete', 'delete'].includes(action || '')) return json({ error: 'Unknown action' }, 400);
  if (action !== 'list' && !userId) return json({ error: 'user_id is required' }, 400);
  if (userId === actor.id && ['block', 'delete'].includes(action || '')) return json({ error: 'You cannot block or delete your own account' }, 400);
  if (userId && ['block', 'delete'].includes(action || '')) {
    const { data: targetAdmin, error: targetAdminError } = await admin.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
    if (targetAdminError) return json({ error: 'Unable to verify target account role' }, 500);
    if (targetAdmin) return json({ error: 'Platform administrator accounts cannot be blocked or deleted here' }, 400);
  }

  const accountInfo = async (id: string) => {
    const [{ data: userResult, error: userError }, { data: access, error: accessError }, { data: orgs, error: orgError }] = await Promise.all([
      admin.auth.admin.getUserById(id),
      admin.from('account_access').select('status, reason').eq('user_id', id).maybeSingle(),
      admin.from('organizations').select('id').eq('created_by', id),
    ]);
    if (userError || !userResult?.user || accessError || orgError) throw new Error('Unable to read account data');
    const organizationIds = (orgs || []).map((item) => item.id);
    let competitionCount = 0;
    if (organizationIds.length) {
      const { count, error } = await admin.from('competitions').select('id', { count: 'exact', head: true }).in('organization_id', organizationIds);
      if (error) throw new Error('Unable to count competitions');
      competitionCount = count || 0;
    }
    return { user: userResult.user, status: access?.status || 'active', reason: access?.reason || null, organizationCount: organizationIds.length, competitionCount };
  };

  try {
    if (action === 'list') {
      const [{ data: accessRows, error: accessError }, { data: orgs, error: orgError }, { data: competitions, error: competitionsError }] = await Promise.all([
        admin.from('account_access').select('user_id, status, reason, updated_at'),
        admin.from('organizations').select('id, created_by'),
        admin.from('competitions').select('id, organization_id'),
      ]);
      if (accessError || orgError || competitionsError) throw new Error('Unable to list accounts');
      const users = [];
      for (let page = 1; ; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error('Unable to list accounts');
        users.push(...data.users);
        if (data.users.length < 1000) break;
      }
      const accessByUser = new Map((accessRows || []).map((row) => [row.user_id, row]));
      const orgIdsByUser = new Map<string, Set<string>>();
      for (const org of orgs || []) {
        if (!orgIdsByUser.has(org.created_by)) orgIdsByUser.set(org.created_by, new Set());
        orgIdsByUser.get(org.created_by)!.add(org.id);
      }
      const competitionsByUser = new Map<string, number>();
      for (const competition of competitions || []) {
        for (const [id, orgIds] of orgIdsByUser) if (orgIds.has(competition.organization_id)) competitionsByUser.set(id, (competitionsByUser.get(id) || 0) + 1);
      }
      return json({ users: users.map((user) => {
        const access = accessByUser.get(user.id);
        const organizationIds = orgIdsByUser.get(user.id);
        return { id: user.id, email: user.email, created_at: user.created_at, status: access?.status || 'active', reason: access?.reason || null, updated_at: access?.updated_at || null, organization_count: organizationIds?.size || 0, competition_count: competitionsByUser.get(user.id) || 0 };
      }) });
    }

    const target = await accountInfo(userId!);
    if (action === 'preview_delete') return json({ email: target.user.email, organization_count: target.organizationCount, competition_count: target.competitionCount });
    if (action === 'block' || action === 'unblock') {
      const { error } = await admin.from('account_access').upsert({
        user_id: userId,
        status: action === 'block' ? 'blocked' : 'active',
        reason: action === 'block' ? (input.reason || '').trim().slice(0, 500) || null : null,
        updated_by: actor.id,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (error) throw new Error('Unable to update account access');
      return json({ ok: true });
    }
    if (action === 'delete') {
      const { error } = await admin.auth.admin.deleteUser(userId!);
      if (error) throw new Error('Unable to delete account');
      return json({ ok: true, deleted_organization_count: target.organizationCount, deleted_competition_count: target.competitionCount });
    }
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Request failed' }, 500);
  }
  return json({ error: 'Request failed' }, 500);
});
