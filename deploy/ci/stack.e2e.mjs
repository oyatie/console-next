// SPDX-License-Identifier: LicenseRef-Proprietary
// Class B uses the deployable binary and synthetic database; no e2e feature or dev-auth is compiled in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
const origin=process.env.PLATFORM_TEST_URL;
assert.ok(origin,'PLATFORM_TEST_URL must target the ephemeral stack');
test('both the built Korean web shell and runtime API are served by the image',async()=>{
  const response=await fetch(origin);assert.equal(response.status,200);
  const html=await response.text();assert.match(html,/<!doctype html>/i);assert.match(html,/lang="ko"/);
  const health=await fetch(`${origin}/healthz`).then(r=>r.json());assert.equal(health.status,'ok');assert.equal(health.role,'api');
});
test('readiness proves runtime and all three command database pools',async()=>{
  const response=await fetch(`${origin}/readyz`);assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.status,'ready');
  for(const name of ['database','leave_command_database','ontology_command_database','platform_force_command_database']) assert.equal(body[name],'ready',name);
});
test('the release binary exposes no development identity endpoint',async()=>{
  const response=await fetch(`${origin}/api/v1/dev-auth/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({persona:'vendor'})});
  assert.equal(response.status,404);
});

test('cold-start sign-in seeds an enrollment session and refuses business access and replay',async()=>{
  const encoded=execFileSync('kubectl',['get','secret','console-api','-n','console','-o','jsonpath={.data.CONSOLE_COLDSTART_OTP}'],{encoding:'utf8'});
  const otp=Buffer.from(encoded,'base64').toString();
  const redeem=()=>fetch(`${origin}/api/v1/auth/otp/redeem`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({otp})});
  const response=await redeem();assert.equal(response.status,200,'PLAT_COLDSTART: one-time code must redeem');
  const session=await response.json();assert.equal(session.requires_passkey_setup,true);
  const headers={authorization:`Bearer ${session.access_token}`};
  const consent=await fetch(`${origin}/api/v1/auth/privacy-consent/status`,{method:'POST',headers});
  assert.equal(consent.status,200,'PLAT_COLDSTART: enrollment session must reach the consent notice');
  assert.equal((await consent.json()).accepted,false,'PLAT_COLDSTART: a fresh account has not accepted consent');
  const me=await fetch(`${origin}/api/v1/users/me`,{headers});
  assert.equal(me.status,403,'PLAT_COLDSTART: enrollment session must not read business APIs');
  assert.equal((await me.json()).error?.code,'passkey_required','PLAT_COLDSTART: business access must require a passkey');
  const replay=await redeem();assert.equal(replay.status,401,'PLAT_COLDSTART: one-time code replay must be refused');
});
