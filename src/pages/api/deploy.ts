import type { APIRoute } from 'astro';
import { execSync } from 'child_process';

export const POST: APIRoute = async ({ request }) => {
  const auth = request.headers.get('Authorization') ?? '';
  const secret = process.env.DEPLOY_SECRET;

  if (!secret) {
    return new Response(
      JSON.stringify({ status: 'error', message: 'DEPLOY_SECRET not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (auth !== `Bearer ${secret}`) {
    return new Response(
      JSON.stringify({ status: 'error', message: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const output = execSync(
      'git -C /app/src/content/blog fetch origin && git -C /app/src/content/blog reset --hard origin/main',
      { encoding: 'utf8', timeout: 30000 }
    );
    return new Response(
      JSON.stringify({ status: 'ok', output }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ status: 'error', message: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
